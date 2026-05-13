/**
 * LeadWase — Cloud Functions (Node 18 / Express)
 *
 * Config :
 *   firebase functions:config:set gateway.api_key="gw_..." site.url="https://leadwase.com"
 */
const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const express   = require('express');
const cors      = require('cors');
const fetch     = require('node-fetch');

admin.initializeApp();
const db = admin.firestore();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const GW_KEY  = functions.config().gateway?.api_key  || process.env.GATEWAY_API_KEY || '';
const GW_URL  = 'https://paymentgateway.lfdweb.com';
const SITE    = functions.config().site?.url          || process.env.SITE_URL        || 'https://leadwase.com';

// ── helpers ──────────────────────────────────────────────────────────
function genId()  { return 'LW-' + Math.floor(10000 + Math.random() * 90000); }
function genPwd(n = 10) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#!';
  return Array.from({ length: n }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

// ── middleware ───────────────────────────────────────────────────────
async function auth(req, res, next) {
  const token = (req.headers.authorization || '').split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  try { req.user = await admin.auth().verifyIdToken(token); next(); }
  catch { res.status(401).json({ error: 'Token invalide' }); }
}

async function adminOnly(req, res, next) {
  const u = await db.collection('users').doc(req.user.uid).get();
  if (u.data()?.role !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
  next();
}

// ── POST /api/orders/create ──────────────────────────────────────────
app.post('/orders/create', auth, async (req, res) => {
  try {
    const { cardType, firstName, lastName, jobTitle, company, phone, email, address } = req.body;
    const uid = req.user.uid;
    const amount = 2500;

    const orderRef = await db.collection('orders').add({
      uid, cardType, firstName, lastName, jobTitle, company, phone, email, address,
      amount: cardType === 'classic' ? amount : null,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (cardType === 'b2b') return res.json({ success: true, orderId: orderRef.id, type: 'b2b' });

    const payRef = await db.collection('payments').add({
      uid, orderId: orderRef.id, amount, status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const gRes = await fetch(`${GW_URL}/api/gateway/generate-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': GW_KEY },
      body: JSON.stringify({
        amount, country: 'bj',
        description: `Carte LeadWase — ${firstName} ${lastName}`,
        origin: SITE, sendWebhook: true,
        metadata: { transactionId: payRef.id, orderId: orderRef.id, uid, origin: SITE, sendWebhook: true },
      }),
    });
    const gData = await gRes.json();
    await payRef.update({ pid: gData.pid, payUrl: gData.url });
    await orderRef.update({ paymentId: payRef.id, pid: gData.pid });
    res.json({ success: true, orderId: orderRef.id, payUrl: gData.url });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── POST /api/subscriptions/create ──────────────────────────────────
app.post('/subscriptions/create', auth, async (req, res) => {
  try {
    const { plan } = req.body;
    const uid = req.user.uid;
    const prices = { pro: 2999, business: 4566 };
    const amount = prices[plan];
    if (!amount) return res.status(400).json({ error: 'Plan invalide' });

    const subRef = await db.collection('subscriptions').add({
      uid, plan, amount, status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const payRef = await db.collection('payments').add({
      uid, subscriptionId: subRef.id, amount, status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const gRes = await fetch(`${GW_URL}/api/gateway/generate-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': GW_KEY },
      body: JSON.stringify({
        amount, country: 'bj',
        description: `LeadWase ${plan.toUpperCase()} — 1 mois`,
        origin: SITE, sendWebhook: true,
        metadata: { transactionId: payRef.id, subscriptionId: subRef.id, plan, uid, origin: SITE, sendWebhook: true },
      }),
    });
    const gData = await gRes.json();
    await payRef.update({ pid: gData.pid });
    await subRef.update({ paymentId: payRef.id, pid: gData.pid });
    res.json({ success: true, payUrl: gData.url });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── POST /api/webhook/payment ────────────────────────────────────────
app.post('/webhook/payment', async (req, res) => {
  try {
    const { event, transaction } = req.body;
    const raw = (transaction?.status || event || '').toLowerCase();
    const ok  = ['successful','success','completed','paid','payment.completed'].includes(raw);
    const ko  = ['failed','failure','cancelled','rejected','payment.failed'].includes(raw);
    if (!ok && !ko) return res.json({ received: true, status: 'ignored' });

    let payDoc = null;

    // 1. Via metadata.transactionId
    const txId = transaction?.metadata?.transactionId;
    if (txId) { const d = await db.collection('payments').doc(txId).get(); if (d.exists) payDoc = d; }

    // 2. Fallback pid / reference
    if (!payDoc) {
      const ref = transaction?.reference || transaction?.id;
      if (ref) { const s = await db.collection('payments').where('pid','==',ref).limit(1).get(); if (!s.empty) payDoc = s.docs[0]; }
    }

    // 3. Fallback dernier pending même montant
    if (!payDoc && transaction?.amount) {
      const s = await db.collection('payments')
        .where('status','==','pending').where('amount','==',transaction.amount)
        .orderBy('createdAt','desc').limit(1).get();
      if (!s.empty) payDoc = s.docs[0];
    }

    if (!payDoc) return res.json({ received: true });
    const pay = payDoc.data();
    if (pay.status === 'success') return res.json({ received: true }); // anti-doublon

    const status = ok ? 'success' : 'failed';
    await payDoc.ref.update({ status, gatewayRef: transaction?.reference, webhookVerified: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    if (ok) {
      // Paiement carte
      if (pay.orderId) {
        const ord   = await db.collection('orders').doc(pay.orderId).get();
        const oData = ord.data();
        let lwId = genId();
        const ex = await db.collection('profiles').where('leadwaseId','==',lwId).get();
        if (!ex.empty) lwId = genId();
        const pwd = genPwd();
        await ord.ref.update({ status: 'paid', leadwaseId: lwId, paidAt: admin.firestore.FieldValue.serverTimestamp() });
        await db.collection('profiles').doc(lwId).set({
          uid: pay.uid, leadwaseId: lwId,
          firstName: oData.firstName, lastName: oData.lastName,
          jobTitle: oData.jobTitle, company: oData.company,
          phone: oData.phone, email: oData.email,
          plan: 'free', createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        await db.collection('credentials').doc(lwId).set({ uid: pay.uid, leadwaseId: lwId, passwordHash: pwd, createdAt: admin.firestore.FieldValue.serverTimestamp() });
        await db.collection('users').doc(pay.uid).set({ leadwaseId: lwId, plan: 'free', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      }

      // Paiement abonnement
      if (pay.subscriptionId) {
        const sub   = await db.collection('subscriptions').doc(pay.subscriptionId).get();
        const sData = sub.data();
        const exp   = new Date(); exp.setMonth(exp.getMonth() + 1);
        await sub.ref.update({ status: 'active', startDate: admin.firestore.FieldValue.serverTimestamp(), expiryDate: admin.firestore.Timestamp.fromDate(exp) });
        await db.collection('users').doc(pay.uid).update({ plan: sData.plan, planExpiry: admin.firestore.Timestamp.fromDate(exp), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        const uDoc = await db.collection('users').doc(pay.uid).get();
        if (uDoc.data()?.leadwaseId) await db.collection('profiles').doc(uDoc.data().leadwaseId).update({ plan: sData.plan });
      }
    }

    res.json({ received: true, status });
  } catch (e) { console.error('webhook:', e); res.status(500).json({ error: e.message }); }
});

// ── GET /api/profile/:id ─────────────────────────────────────────────
app.get('/profile/:id', async (req, res) => {
  try {
    const snap = await db.collection('profiles').doc(req.params.id.toUpperCase()).get();
    if (!snap.exists) return res.status(404).json({ error: 'Profil introuvable' });
    const { uid, ...pub } = snap.data();
    res.json({ success: true, profile: pub });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/admin/stats ─────────────────────────────────────────────
app.get('/admin/stats', auth, adminOnly, async (req, res) => {
  try {
    const [orders, payments, subs] = await Promise.all([
      db.collection('orders').get(),
      db.collection('payments').where('status','==','success').get(),
      db.collection('subscriptions').where('status','==','active').get(),
    ]);
    const pending = orders.docs.filter(d => ['pending','paid'].includes(d.data().status)).length;
    const revenue = payments.docs.reduce((a, d) => a + (d.data().amount || 0), 0);
    res.json({ success: true, stats: { totalOrders: orders.size, totalRevenue: revenue, activeSubscriptions: subs.size, pendingOrders: pending } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/admin/orders ────────────────────────────────────────────
app.get('/admin/orders', auth, adminOnly, async (req, res) => {
  try {
    const snap = await db.collection('orders').orderBy('createdAt','desc').limit(50).get();
    res.json({ success: true, orders: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/admin/generate-credentials ────────────────────────────
app.post('/admin/generate-credentials', auth, adminOnly, async (req, res) => {
  try {
    const { orderId } = req.body;
    const order = await db.collection('orders').doc(orderId).get();
    if (!order.exists) return res.status(404).json({ error: 'Commande introuvable' });
    const d = order.data();
    if (d.leadwaseId) return res.json({ success: true, leadwaseId: d.leadwaseId, alreadyCreated: true });

    let lwId = genId();
    const ex = await db.collection('profiles').where('leadwaseId','==',lwId).get();
    if (!ex.empty) lwId = genId();
    const pwd = genPwd();

    await db.collection('profiles').doc(lwId).set({ uid: d.uid, leadwaseId: lwId, firstName: d.firstName, lastName: d.lastName, jobTitle: d.jobTitle, company: d.company, phone: d.phone, email: d.email, plan: 'free', createdAt: admin.firestore.FieldValue.serverTimestamp() });
    await db.collection('credentials').doc(lwId).set({ uid: d.uid, leadwaseId: lwId, passwordHash: pwd, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    await db.collection('users').doc(d.uid).set({ leadwaseId: lwId, plan: 'free' }, { merge: true });
    await order.ref.update({ status: 'delivered', leadwaseId: lwId });

    res.json({ success: true, leadwaseId: lwId, password: pwd });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

exports.api = functions.https.onRequest(app);