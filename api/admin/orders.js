// api/admin/orders.js — GET /api/admin/orders (liste)
//                        POST /api/admin/orders?action=deliver               { orderId }
//                        POST /api/admin/orders?action=generate-credentials  { orderId }
// Regroupées dans un seul fichier (cycle de vie d'une commande) pour rester
// sous la limite de 12 fonctions serverless du plan Vercel Hobby.
import { db, verifyAdmin, setCors } from '../../lib/firebaseAdmin.js';

function genId()  { return 'LW-' + Math.floor(10000 + Math.random() * 90000); }
function genPwd(n = 12) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const special = '@#!$%&*';
  const all = upper + lower + digits + special;
  const pwd = [
    upper[Math.floor(Math.random() * upper.length)],
    lower[Math.floor(Math.random() * lower.length)],
    digits[Math.floor(Math.random() * digits.length)],
    special[Math.floor(Math.random() * special.length)],
  ];
  for (let i = pwd.length; i < n; i++) pwd.push(all[Math.floor(Math.random() * all.length)]);
  for (let i = pwd.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pwd[i], pwd[j]] = [pwd[j], pwd[i]];
  }
  return pwd.join('');
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

// POST /api/admin/orders?action=provision-b2b-team  { orderId, confirmedQuantity }
// Crée le profil du chef d'entreprise + un sous-profil par carte confirmée,
// tous liés (parentLeadwaseId / teamMembers), avec le forfait choisi à la commande.
async function provisionB2BTeam(req, res) {
  const { orderId, confirmedQuantity } = req.body;
  const qty = parseInt(confirmedQuantity, 10);
  if (!orderId || !qty || qty < 1 || qty > 500) {
    return res.status(400).json({ success: false, error: 'orderId et confirmedQuantity (1-500) requis' });
  }

  const orderRef = db.collection('orders').doc(orderId);
  const order = await orderRef.get();
  if (!order.exists) return res.status(404).json({ success: false, error: 'Commande introuvable' });
  const d = order.data();
  if (d.cardType !== 'b2b') return res.status(400).json({ success: false, error: "Cette commande n'est pas une commande B2B" });
  if (d.teamProvisioned) return res.json({ success: true, alreadyCreated: true, chefLeadwaseId: d.chefLeadwaseId });

  const plan = ['free', 'pro', 'business'].includes(d.subPlan) ? d.subPlan : 'free';
  const usedIds = new Set();
  async function uniqueId() {
    let id = genId();
    while (usedIds.has(id) || (await db.collection('profiles').doc(id).get()).exists) id = genId();
    usedIds.add(id);
    return id;
  }

  // ── Chef d'entreprise ──────────────────────────────────────────────────────
  const chefId  = await uniqueId();
  const chefPwd = genPwd();
  await db.collection('profiles').doc(chefId).set({
    leadwaseId: chefId, firstName: d.firstName, lastName: '', company: d.company,
    phone: d.phone || '', email: d.email, plan,
    isTeamOwner: true, teamMembers: [], teamOrderId: orderId, createdAt: new Date(),
  });
  await db.collection('credentials').doc(chefId).set({ leadwaseId: chefId, passwordHash: chefPwd, createdAt: new Date() });

  // ── Sous-comptes (employés) ──────────────────────────────────────────────────
  const employees = Array.isArray(d.employees) ? d.employees : [];
  const teamMembers = [];
  for (let i = 0; i < qty; i++) {
    const emp = employees[i] || {};
    const subId  = await uniqueId();
    const subPwd = genPwd();
    await db.collection('profiles').doc(subId).set({
      leadwaseId: subId, firstName: emp.name || '', lastName: '', company: d.company,
      phone: emp.phone || '', email: emp.email || '', plan,
      parentLeadwaseId: chefId, teamOrderId: orderId, createdAt: new Date(),
    });
    await db.collection('credentials').doc(subId).set({ leadwaseId: subId, passwordHash: subPwd, createdAt: new Date() });
    teamMembers.push(subId);
  }
  await db.collection('profiles').doc(chefId).update({ teamMembers });

  await orderRef.update({
    status: 'delivered', deliveredAt: new Date(),
    chefLeadwaseId: chefId, teamProvisioned: true, confirmedQuantity: qty,
  });

  try {
    const { notifyB2BTeamProvisioned } = await import('../../lib/brevo.js');
    await notifyB2BTeamProvisioned({ firstName: d.firstName, email: d.email, leadwaseId: chefId, password: chefPwd, teamSize: qty });
  } catch (e) {
    console.error('[provisionB2BTeam] email échoué:', e.message);
  }

  res.json({ success: true, chefLeadwaseId: chefId, teamSize: qty });
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
    if (req.method === 'POST' && action === 'provision-b2b-team') return provisionB2BTeam(req, res);

    res.status(400).json({ success: false, error: 'Requête invalide' });
  } catch (e) {
    res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message });
  }
}
