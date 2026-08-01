// api/admin/orders.js — GET /api/admin/orders (liste)
//                        POST /api/admin/orders?action=deliver               { orderId }
//                        POST /api/admin/orders?action=generate-credentials  { orderId }
// Regroupées dans un seul fichier (cycle de vie d'une commande) pour rester
// sous la limite de 12 fonctions serverless du plan Vercel Hobby.
import { db, verifyAdmin, setCors } from '../../lib/firebaseAdmin.js';

function genId()  { return 'LW-' + Math.floor(10000 + Math.random() * 90000); }
function genPwd(n = 10) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#!';
  return Array.from({ length: n }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

async function listOrders(req, res) {
  const snap = await db.collection('orders').orderBy('createdAt', 'desc').limit(200).get();
  const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  res.json({ success: true, orders });
}

async function deliver(req, res) {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ success: false, error: 'orderId requis' });
  await db.collection('orders').doc(orderId).update({ status: 'delivered', deliveredAt: new Date() });
  res.json({ success: true });
}

async function generateCredentials(req, res) {
  const { orderId } = req.body;
  const order = await db.collection('orders').doc(orderId).get();
  if (!order.exists) return res.status(404).json({ success: false, error: 'Commande introuvable' });
  const d = order.data();
  if (d.leadwaseId) return res.json({ success: true, leadwaseId: d.leadwaseId, alreadyCreated: true });

  let lwId = genId();
  const ex = await db.collection('profiles').where('leadwaseId', '==', lwId).get();
  if (!ex.empty) lwId = genId();
  const pwd = genPwd();

  await db.collection('profiles').doc(lwId).set({
    uid: d.uid, leadwaseId: lwId, firstName: d.firstName, lastName: d.lastName,
    jobTitle: d.jobTitle, company: d.company, phone: d.phone, email: d.email,
    plan: 'free', createdAt: new Date(),
  });
  await db.collection('credentials').doc(lwId).set({
    uid: d.uid, leadwaseId: lwId, passwordHash: pwd, createdAt: new Date(),
  });
  await db.collection('users').doc(d.uid).set({ leadwaseId: lwId, plan: 'free' }, { merge: true });
  await order.ref.update({ status: 'delivered', leadwaseId: lwId });

  res.json({ success: true, leadwaseId: lwId, password: pwd });
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    await verifyAdmin(req);
    const action = req.query.action;

    if (req.method === 'GET' && !action) return listOrders(req, res);
    if (req.method === 'POST' && action === 'deliver') return deliver(req, res);
    if (req.method === 'POST' && action === 'generate-credentials') return generateCredentials(req, res);

    res.status(400).json({ success: false, error: 'Requête invalide' });
  } catch (e) {
    res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message });
  }
}
