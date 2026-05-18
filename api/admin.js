// api/admin.js — Routeur unique pour TOUTES les routes admin
// Remplace : api/admin/orders.js, payments.js, subscriptions.js,
//            credentials.js, stats.js, b2b.js, deliver.js,
//            generate-credentials.js, settings/prices.js
//
// Routes disponibles (via le paramètre ?route=xxx) :
//   GET  ?route=orders
//   GET  ?route=payments
//   GET  ?route=subscriptions
//   GET  ?route=credentials
//   GET  ?route=stats
//   GET  ?route=b2b
//   POST ?route=deliver
//   POST ?route=generate-credentials
//   GET  ?route=settings-prices
//   POST ?route=settings-prices

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  })});
}
const db = getFirestore();

// ── Auth ─────────────────────────────────────────────────────
async function verifyToken(req) {
  const { getAuth } = await import('firebase-admin/auth');
  const token = (req.headers.authorization || '').split('Bearer ')[1];
  if (!token) throw new Error('Non autorisé');
  return getAuth().verifyIdToken(token);
}

// ── Prix par défaut ───────────────────────────────────────────
const DEFAULT_PRICES = { classic: 25000, pro: 3500, business: 9900 };

async function getPrices() {
  try {
    const snap = await db.collection('settings').doc('prices').get();
    if (snap.exists) {
      const d = snap.data();
      return {
        classic:  d.classic  || DEFAULT_PRICES.classic,
        pro:      d.pro      || DEFAULT_PRICES.pro,
        business: d.business || DEFAULT_PRICES.business,
      };
    }
  } catch (e) {
    console.warn('[getPrices] fallback:', e.message);
  }
  return DEFAULT_PRICES;
}

// ── Handler principal ─────────────────────────────────────────
export default async function handler(req, res) {
  // CORS pour dev local si besoin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await verifyToken(req);
  } catch (e) {
    return res.status(401).json({ success: false, error: 'Non autorisé' });
  }

  const route = req.query.route || '';

  try {
    // ════════════════════════════════════════════
    // GET orders
    // ════════════════════════════════════════════
    if (route === 'orders' && req.method === 'GET') {
      const snap = await db.collection('orders')
        .orderBy('createdAt', 'desc').limit(200).get();
      const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return res.json({ success: true, orders });
    }

    // ════════════════════════════════════════════
    // GET payments
    // ════════════════════════════════════════════
    if (route === 'payments' && req.method === 'GET') {
      const snap = await db.collection('payments')
        .orderBy('createdAt', 'desc').limit(200).get();
      const payments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return res.json({ success: true, payments });
    }

    // ════════════════════════════════════════════
    // GET subscriptions
    // ════════════════════════════════════════════
    if (route === 'subscriptions' && req.method === 'GET') {
      const snap = await db.collection('subscriptions')
        .orderBy('createdAt', 'desc').limit(200).get();
      const subscriptions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return res.json({ success: true, subscriptions });
    }

    // ════════════════════════════════════════════
    // GET credentials
    // ════════════════════════════════════════════
    if (route === 'credentials' && req.method === 'GET') {
      const snap = await db.collection('credentials')
        .orderBy('createdAt', 'desc').limit(500).get();
      const credentials = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return res.json({ success: true, credentials });
    }

    // ════════════════════════════════════════════
    // GET b2b
    // ════════════════════════════════════════════
    if (route === 'b2b' && req.method === 'GET') {
      const snap = await db.collection('orders')
        .where('cardType', '==', 'b2b')
        .orderBy('createdAt', 'desc').limit(200).get();
      const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return res.json({ success: true, orders });
    }

    // ════════════════════════════════════════════
    // GET stats
    // ════════════════════════════════════════════
    if (route === 'stats' && req.method === 'GET') {
      const now   = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);

      const [ordersSnap, subsSnap, profilesSnap] = await Promise.all([
        db.collection('orders').orderBy('createdAt', 'desc').limit(500).get(),
        db.collection('subscriptions').get(),
        db.collection('profiles').get(),
      ]);

      const orders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const subs   = subsSnap.docs.map(d => d.data());

      const thisMonth   = orders.filter(o => {
        const d = o.createdAt?._seconds ? new Date(o.createdAt._seconds*1000) : new Date(o.createdAt);
        return d >= start;
      });
      const paid        = orders.filter(o => o.status === 'paid' || o.status === 'delivered');
      const totalRevenue= paid.reduce((s,o) => s + (o.amount||0), 0);
      const pending     = orders.filter(o => o.status === 'pending');
      const activeSubs  = subs.filter(s => s.status === 'active');

      return res.json({
        success: true,
        stats: {
          totalOrders:         thisMonth.length,
          totalRevenue,
          activeSubscriptions: activeSubs.length,
          pendingOrders:       pending.length,
          freeProfiles:        profilesSnap.size,
          proPlan:             activeSubs.filter(s => s.plan === 'pro').length,
          businessPlan:        activeSubs.filter(s => s.plan === 'business').length,
        },
      });
    }

    // ════════════════════════════════════════════
    // GET settings-prices
    // ════════════════════════════════════════════
    if (route === 'settings-prices' && req.method === 'GET') {
      const prices = await getPrices();
      return res.json({ success: true, prices });
    }

    // ════════════════════════════════════════════
    // POST settings-prices
    // ════════════════════════════════════════════
    if (route === 'settings-prices' && req.method === 'POST') {
      const { prices } = req.body;
      if (!prices || typeof prices !== 'object') {
        return res.status(400).json({ success: false, error: 'Corps invalide' });
      }
      const classic  = parseInt(prices.classic)  || 0;
      const pro      = parseInt(prices.pro)       || 0;
      const business = parseInt(prices.business)  || 0;
      if (classic <= 0 || pro <= 0 || business <= 0) {
        return res.status(400).json({ success: false, error: 'Tous les prix doivent être > 0' });
      }
      await db.collection('settings').doc('prices').set(
        { classic, pro, business, updatedAt: new Date() },
        { merge: true }
      );
      return res.json({ success: true, prices: { classic, pro, business } });
    }

    // ════════════════════════════════════════════
    // POST deliver  (marquer une commande livrée)
    // ════════════════════════════════════════════
    if (route === 'deliver' && req.method === 'POST') {
      const { orderId } = req.body;
      if (!orderId) return res.status(400).json({ success: false, error: 'orderId requis' });
      await db.collection('orders').doc(orderId).update({
        status: 'delivered', deliveredAt: new Date(),
      });
      return res.json({ success: true });
    }

    // Route inconnue
    return res.status(404).json({ success: false, error: `Route inconnue : ${route}` });

  } catch (e) {
    console.error(`[admin?route=${route}]`, e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
}
