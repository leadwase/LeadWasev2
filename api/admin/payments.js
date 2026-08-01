// api/admin/payments.js — GET /api/admin/payments (liste)
//                          GET /api/admin/payments?action=stats (agrégats globaux)
// Regroupées dans un seul fichier pour rester sous la limite de 12 fonctions
// serverless du plan Vercel Hobby (stats est un simple agrégat, peu coûteux).
import { db, verifyAdmin, setCors } from '../../lib/firebaseAdmin.js';

async function listPayments(req, res) {
  const snap = await db.collection('payments').orderBy('createdAt', 'desc').limit(200).get();
  const payments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  res.json({ success: true, payments });
}

async function stats(req, res) {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);

  const [ordersSnap, subsSnap, profilesSnap, paymentsSnap] = await Promise.all([
    db.collection('orders').orderBy('createdAt', 'desc').limit(500).get(),
    db.collection('subscriptions').get(),
    db.collection('profiles').get(),
    db.collection('payments').where('status', '==', 'success').get(),
  ]);

  const orders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const subs   = subsSnap.docs.map(d => d.data());

  const thisMonth = orders.filter(o => {
    const d = o.createdAt?._seconds ? new Date(o.createdAt._seconds * 1000) : new Date(o.createdAt);
    return d >= start;
  });

  const paidOrderIds = new Set(
    orders.filter(o => o.status === 'paid' || o.status === 'delivered').map(o => o.id)
  );

  const totalRevenue = paymentsSnap.docs.reduce((sum, d) => {
    const p      = d.data();
    const amount = Number(p.amount) || 0;
    if (p.orderId && paidOrderIds.has(p.orderId)) return sum + amount;
    if (p.subscriptionId) return sum + amount;
    return sum;
  }, 0);

  const pending    = orders.filter(o => o.status === 'pending');
  const activeSubs = subs.filter(s => s.status === 'active');

  res.json({
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

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    await verifyAdmin(req);
    if (req.query.action === 'stats') return stats(req, res);
    return listPayments(req, res);
  } catch (e) {
    res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message });
  }
}
