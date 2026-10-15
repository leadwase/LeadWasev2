// api/admin/orders.js — GET /api/admin/orders (liste)
//                        POST /api/admin/orders?action=deliver               { orderId }
//                        POST /api/admin/orders?action=generate-credentials  { orderId }
//                        GET  /api/admin/orders?action=notifications          (centre de notifications admin)
//                        POST /api/admin/orders?action=mark-notifications-read
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
  const { orderId, confirmedQuantity, pricePerCard } = req.body;
  const qty = parseInt(confirmedQuantity, 10);
  const cardPrice = parseInt(pricePerCard, 10);
  if (!orderId || !qty || qty < 1 || qty > 500) {
    return res.status(400).json({ success: false, error: 'orderId et confirmedQuantity (1-500) requis' });
  }
  if (!cardPrice || cardPrice < 1) {
    return res.status(400).json({ success: false, error: 'pricePerCard requis (prix négocié par carte)' });
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
    isTeamOwner: true, teamMembers: [], teamOrderId: orderId, pricePerCard: cardPrice, createdAt: new Date(),
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

// ── Centre de notifications admin ─────────────────────────────────────────────
// Les notifications sont calculées à partir de l'état réel des commandes, paiements et
// abonnements (aucune duplication de données). Seul l'instant de dernière lecture est
// mémorisé (adminState/{uid}.lastReadAt) : une notification est « non lue » si son
// événement est plus récent que cet instant.
const DAY = 86400000;
const ms = (v) => {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v._seconds) return v._seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
};
const fcfa = (n) => (Number(n) || 0).toLocaleString('fr-FR') + ' FCFA';
const fullName = (o) => [o.firstName, o.lastName].filter(Boolean).join(' ') || o.company || o.email || 'Client';

async function getNotifications(req, res, decoded) {
  const now = Date.now();
  const [ordersSnap, paymentsSnap, subsSnap, stateDoc] = await Promise.all([
    db.collection('orders').orderBy('createdAt', 'desc').limit(200).get(),
    db.collection('payments').orderBy('createdAt', 'desc').limit(200).get(),
    db.collection('subscriptions').orderBy('createdAt', 'desc').limit(200).get(),
    db.collection('adminState').doc(decoded.uid).get(),
  ]);
  const lastReadAt = ms(stateDoc.exists ? stateDoc.data().lastReadAt : 0);
  const list = [];
  const add = (n) => { if (n.date && n.date <= now + DAY) list.push(n); };

  ordersSnap.docs.forEach(d => {
    const o = d.data();
    const created = ms(o.createdAt);
    if (o.provisionError) {
      add({ id: 'provision_error:' + d.id, type: 'provision_error', level: 'action', title: "Cartes d'équipe à créer manuellement",
        detail: `${o.company || fullName(o)} · ${o.provisionError}`, date: ms(o.paidAt) || created, link: 'commandes.html' });
    } else if (o.status === 'b2b_pending') {
      add({ id: 'b2b:' + d.id, type: 'b2b', level: 'action', title: `Demande B2B — ${o.company || fullName(o)}`,
        detail: `${o.quantity ? o.quantity + ' carte(s) · ' : ''}${o.email || ''}`.trim(), date: created, link: 'b2b.html' });
    } else if (o.status === 'paid' && !o.leadwaseId && o.cardType !== 'b2b') {
      add({ id: 'order_paid:' + d.id, type: 'order_paid', level: 'action', title: `Commande payée — accès à générer`,
        detail: `${fullName(o)} · ${fcfa(o.amount)}`, date: ms(o.paidAt) || created, link: 'commandes.html' });
    } else if (o.status === 'payment_failed' && now - created <= 30 * DAY) {
      add({ id: 'payment_failed:o' + d.id, type: 'payment_failed', level: 'warning', title: 'Paiement de commande échoué',
        detail: `${fullName(o)} · ${fcfa(o.amount)}`, date: created, link: 'paiements.html' });
    } else if (o.status === 'gateway_error' && now - created <= 30 * DAY) {
      add({ id: 'gateway_error:o' + d.id, type: 'gateway_error', level: 'warning', title: 'Erreur de la passerelle de paiement',
        detail: `Commande de ${fullName(o)}`, date: created, link: 'commandes.html' });
    }
  });

  // Paiements d'abonnement échoués (ceux des commandes sont déjà couverts ci-dessus).
  paymentsSnap.docs.forEach(d => {
    const p = d.data();
    const created = ms(p.createdAt);
    if (p.status === 'failed' && !p.orderId && now - created <= 30 * DAY) {
      add({ id: 'payment_failed:p' + d.id, type: 'payment_failed', level: 'warning', title: "Paiement d'abonnement échoué",
        detail: fcfa(p.amount), date: created, link: 'paiements.html' });
    }
  });

  // Abonnements : on ne résout le nom du client que pour ceux qui produisent une notification.
  const subItems = [];
  subsSnap.docs.forEach(d => {
    const s = d.data();
    const expiry = ms(s.expiryDate);
    const planLabel = (s.plan || '').toUpperCase();
    if (s.status === 'active' && expiry) {
      if (expiry <= now) {
        subItems.push({ s, n: { id: 'sub_overdue:' + d.id, type: 'sub_overdue', level: 'warning', title: `Abonnement ${planLabel} arrivé à échéance`,
          date: expiry, link: 'abonnements.html', extra: `expiré le ${new Date(expiry).toLocaleDateString('fr-FR')}` } });
      } else if (expiry - now <= 7 * DAY) {
        const days = Math.max(1, Math.ceil((expiry - now) / DAY));
        subItems.push({ s, n: { id: 'sub_expiring:' + d.id, type: 'sub_expiring', level: 'warning', title: `Abonnement ${planLabel} bientôt expiré`,
          date: expiry - 7 * DAY, link: 'abonnements.html', extra: `expire le ${new Date(expiry).toLocaleDateString('fr-FR')} (J-${days})` } });
      }
    }
    if (s.status === 'expired' && now - ms(s.expiredAt) <= 30 * DAY) {
      subItems.push({ s, n: { id: 'sub_expired:' + d.id, type: 'sub_expired', level: 'info', title: `Abonnement ${planLabel} expiré`,
        date: ms(s.expiredAt), link: 'abonnements.html', extra: 'client repassé en Free' } });
    }
    if (s.status === 'active' && ms(s.paidAt) && now - ms(s.paidAt) <= 7 * DAY) {
      subItems.push({ s, n: { id: 'sub_new:' + d.id, type: 'sub_new', level: 'success', title: `Nouvel abonnement ${planLabel}`,
        date: ms(s.paidAt), link: 'abonnements.html', extra: fcfa(s.amount) } });
    }
    if (s.status === 'gateway_error' && now - ms(s.createdAt) <= 30 * DAY) {
      subItems.push({ s, n: { id: 'gateway_error:s' + d.id, type: 'gateway_error', level: 'warning', title: 'Erreur passerelle sur un abonnement',
        date: ms(s.createdAt), link: 'abonnements.html', extra: planLabel } });
    }
  });
  const uids = [...new Set(subItems.map(x => x.s.uid).filter(Boolean))].slice(0, 40);
  const names = {};
  await Promise.all(uids.map(async uid => {
    const q = await db.collection('profiles').where('firebaseUid', '==', uid).limit(1).get();
    if (!q.empty) names[uid] = fullName(q.docs[0].data());
  }));
  subItems.forEach(({ s, n }) => {
    const who = names[s.uid] || 'Client';
    add({ ...n, detail: `${who} · ${n.extra}`, extra: undefined });
  });

  list.sort((a, b) => b.date - a.date);
  const notifications = list.slice(0, 150).map(n => ({ ...n, unread: n.date > lastReadAt }));
  res.json({
    success: true, notifications, lastReadAt: lastReadAt || null,
    unread: notifications.filter(n => n.unread).length,
    actionCount: notifications.filter(n => n.level === 'action').length,
  });
}

async function markNotificationsRead(req, res, decoded) {
  await db.collection('adminState').doc(decoded.uid).set({ lastReadAt: new Date() }, { merge: true });
  res.json({ success: true });
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const decoded = await verifyAdmin(req);
    const action = req.query.action;

    if (req.method === 'GET' && !action) return await listOrders(req, res);
    if (req.method === 'POST' && action === 'deliver') return await deliver(req, res);
    if (req.method === 'POST' && action === 'generate-credentials') return await generateCredentials(req, res);
    if (req.method === 'POST' && action === 'provision-b2b-team') return await provisionB2BTeam(req, res);
    if (req.method === 'GET'  && action === 'notifications') return await getNotifications(req, res, decoded);
    if (req.method === 'POST' && action === 'mark-notifications-read') return await markNotificationsRead(req, res, decoded);

    res.status(400).json({ success: false, error: 'Requête invalide' });
  } catch (e) {
    res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message });
  }
}
