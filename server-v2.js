const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// STORAGE (pakai Map — ganti Redis kalau mau production)
// ============================================================
const orders = new Map();       // orderId → order object
const qrisCache = new Map();    // orderId → qris image base64
let controllerSocket = null;    // WebSocket dari APK Controller

// ============================================================
// WEBSOCKET
// ============================================================
wss.on('connection', (ws, req) => {
  const type = req.url?.includes('controller') ? 'controller' : 'web';

  if (type === 'controller') {
    console.log('✅ APK Controller terhubung!');
    controllerSocket = ws;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        handleControllerMessage(msg);
      } catch (e) {
        console.error('WS parse error:', e);
      }
    });

    ws.on('close', () => {
      console.log('❌ APK Controller disconnect');
      controllerSocket = null;
    });
  }

  if (type === 'web') {
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        // Web bisa subscribe ke order tertentu
        if (msg.type === 'subscribe' && msg.orderId) {
          ws.orderId = msg.orderId;
          console.log(`📡 Web subscribe order: ${msg.orderId}`);

          // Kalau QRIS udah ada, langsung kirim
          if (qrisCache.has(msg.orderId)) {
            ws.send(JSON.stringify({
              type: 'qris_ready',
              orderId: msg.orderId,
              qris: qrisCache.get(msg.orderId)
            }));
          }
        }
      } catch (e) {}
    });
  }
});

// ============================================================
// HANDLE PESAN DARI APK CONTROLLER
// ============================================================
function handleControllerMessage(msg) {
  console.log('📨 Dari controller:', msg.type);

  if (msg.type === 'qris_ready') {
    const { orderId, qrisImage } = msg;
    qrisCache.set(orderId, qrisImage);

    // Update order status
    if (orders.has(orderId)) {
      const order = orders.get(orderId);
      order.status = 'waiting_payment';
      order.qrisAt = new Date().toISOString();
      orders.set(orderId, order);
    }

    // Broadcast ke semua web client yang subscribe order ini
    broadcastToWeb(orderId, {
      type: 'qris_ready',
      orderId,
      qris: qrisImage
    });

    console.log(`✅ QRIS siap untuk order ${orderId}`);
  }

  if (msg.type === 'order_done') {
    const { orderId } = msg;
    if (orders.has(orderId)) {
      const order = orders.get(orderId);
      order.status = 'completed';
      order.completedAt = new Date().toISOString();
      orders.set(orderId, order);
    }

    broadcastToWeb(orderId, {
      type: 'order_completed',
      orderId,
      message: 'Saldo sudah masuk ke e-wallet kamu! ✅'
    });
  }

  if (msg.type === 'order_failed') {
    const { orderId, reason } = msg;
    if (orders.has(orderId)) {
      const order = orders.get(orderId);
      order.status = 'failed';
      orders.set(orderId, order);
    }

    broadcastToWeb(orderId, {
      type: 'order_failed',
      orderId,
      reason: reason || 'Terjadi kesalahan, hubungi admin'
    });
  }
}

function broadcastToWeb(orderId, payload) {
  wss.clients.forEach(client => {
    if (
      client.readyState === WebSocket.OPEN &&
      client.orderId === orderId
    ) {
      client.send(JSON.stringify(payload));
    }
  });
}

function sendToController(payload) {
  if (controllerSocket && controllerSocket.readyState === WebSocket.OPEN) {
    controllerSocket.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

// ============================================================
// API ROUTES
// ============================================================

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'TopupKilat Backend',
    controller: controllerSocket ? 'connected' : 'offline',
    orders: orders.size
  });
});

// Buat order baru (dipanggil dari web customer)
app.post('/api/order/create', (req, res) => {
  try {
    const { wallet, phone, nominal, customerName } = req.body;

    if (!wallet || !phone || !nominal) {
      return res.status(400).json({ success: false, message: 'Data tidak lengkap' });
    }

    const HARGA = {
      1000: 1500, 2000: 2500, 5000: 5500,
      10000: 10500, 20000: 20500, 25000: 25500,
      50000: 51000, 75000: 76000, 100000: 101500
    };

    const nominalInt = parseInt(nominal);
    const hargaJual = HARGA[nominalInt];

    if (!hargaJual) {
      return res.status(400).json({ success: false, message: 'Nominal tidak valid' });
    }

    const orderId = 'TK' + Date.now();
    const order = {
      orderId,
      wallet,
      phone,
      nominal: nominalInt,
      hargaJual,
      customerName: customerName || 'Customer',
      status: 'pending',        // pending → processing → waiting_payment → completed
      createdAt: new Date().toISOString(),
      qrisAt: null,
      completedAt: null
    };

    orders.set(orderId, order);
    console.log(`📦 Order baru: ${orderId} | ${wallet} ${nominalInt} → ${phone}`);

    // Kirim ke APK Controller
    const sent = sendToController({
      type: 'new_order',
      order
    });

    if (!sent) {
      console.warn('⚠️ Controller offline! Order tetap disimpan.');
    }

    res.json({
      success: true,
      orderId,
      hargaJual,
      message: sent
        ? 'Order diterima, QRIS sedang dibuat...'
        : 'Order diterima, harap tunggu (sistem sedang persiapan)'
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Cek status order
app.get('/api/order/:orderId', (req, res) => {
  const order = orders.get(req.params.orderId);
  if (!order) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });

  const qris = qrisCache.get(req.params.orderId) || null;
  res.json({ success: true, order, qris });
});

// List semua order (untuk dashboard admin)
app.get('/api/orders', (req, res) => {
  const list = Array.from(orders.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ success: true, orders: list, total: list.length });
});

// Update status order (dari APK Controller via HTTP)
app.post('/api/order/:orderId/status', (req, res) => {
  const { status, qrisImage } = req.body;
  const order = orders.get(req.params.orderId);
  if (!order) return res.status(404).json({ success: false });

  order.status = status;
  orders.set(req.params.orderId, order);

  if (qrisImage) {
    qrisCache.set(req.params.orderId, qrisImage);
    broadcastToWeb(req.params.orderId, {
      type: 'qris_ready',
      orderId: req.params.orderId,
      qris: qrisImage
    });
  }

  res.json({ success: true });
});

// Midtrans webhook (untuk konfirmasi bayar jika pakai Midtrans)
app.post('/api/webhook/midtrans', (req, res) => {
  const { order_id, transaction_status } = req.body;
  console.log('🔔 Midtrans webhook:', order_id, transaction_status);

  if (transaction_status === 'settlement' || transaction_status === 'capture') {
    const order = orders.get(order_id);
    if (order) {
      order.status = 'paid';
      orders.set(order_id, order);

      sendToController({ type: 'payment_confirmed', orderId: order_id });
      broadcastToWeb(order_id, { type: 'payment_confirmed', orderId: order_id });
    }
  }

  res.json({ status: 'ok' });
});

// Controller status check
app.get('/api/controller/status', (req, res) => {
  res.json({
    online: !!(controllerSocket && controllerSocket.readyState === WebSocket.OPEN)
  });
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 TopupKilat Backend running on port ${PORT}`);
  console.log(`📡 WebSocket ready`);
});
