// lib/adminDelete.js
// Suppression admin (unitaire, sélection, ou « tout vider » par statut) de commandes, paiements et abonnements
// NON aboutis. Garde-fous appliqués côté SERVEUR (jamais seulement dans l'interface) :
//  • seuls certains statuts sont supprimables (en attente, en cours, échoué, erreur, annulé) ;
//    les éléments payés / livrés / actifs / expirés / traités sont protégés (comptabilité) ;
//  • un élément « en attente » créé il y a moins de 10 min est conservé (un paiement peut être en cours) ;
//  • les paiements non aboutis liés à une commande / un abonnement supprimé sont supprimés avec lui ;
//  • chaque suppression est journalisée (collection adminAudit).
import { db } from './firebaseAdmin.js';

const ID_RE = /^[A-Za-z0-9]{1,40}$/;
const GRACE_MS = 10 * 60 * 1000;
const PURGE_LIMIT = 400;

export const DELETABLE = {
  orders:        ['pending', 'b2b_pending', 'payment_failed', 'gateway_error', 'failed', 'cancelled'],
  payments:      ['pending', 'failed', 'payment_failed'],
  subscriptions: ['pending', 'gateway_error', 'cancelled'],
};
const UNFINISHED_PAYMENT = ['pending', 'failed', 'payment_failed'];

const ms = (v) => {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v._seconds) return v._seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
};
class BadRequest extends Error { constructor(m) { super(m); this.status = 400; } }

// Paiements non aboutis rattachés à un document (champ orderId ou subscriptionId).
export const cascadePayments = (field) => async (id) => {
  const snap = await db.collection('payments').where(field, '==', id).get();
  return snap.docs.filter(d => UNFINISHED_PAYMENT.includes(d.data().status)).map(d => d.ref);
};

export async function adminDelete({ collection, body, decoded, cascade }) {
  const allowed = DELETABLE[collection];
  if (!allowed) throw new BadRequest('Collection non supportée');
  const { ids, status } = body && typeof body === 'object' ? body : {};

  let docs, more = false;
  if (Array.isArray(ids)) {
    const clean = [...new Set(ids.map(String).filter(i => ID_RE.test(i)))].slice(0, 500);
    if (!clean.length) throw new BadRequest('Aucun élément sélectionné');
    docs = await db.getAll(...clean.map(i => db.collection(collection).doc(i)));
  } else if (typeof status === 'string') {
    if (!allowed.includes(status)) throw new BadRequest('Ce statut ne peut pas être supprimé');
    const snap = await db.collection(collection).where('status', '==', status).limit(PURGE_LIMIT).get();
    docs = snap.docs; more = snap.size === PURGE_LIMIT;
  } else {
    throw new BadRequest('Requête invalide');
  }

  const now = Date.now();
  const skipped = [];
  const toDelete = [];
  for (const d of docs) {
    if (!d.exists) { skipped.push({ id: d.id, reason: 'introuvable' }); continue; }
    const data = d.data();
    if (!allowed.includes(data.status)) { skipped.push({ id: d.id, reason: `protégé (statut « ${data.status || '—'} »)` }); continue; }
    if (data.status === 'pending' && now - ms(data.createdAt) < GRACE_MS) {
      skipped.push({ id: d.id, reason: 'créé il y a moins de 10 min (paiement peut-être en cours)' }); continue;
    }
    toDelete.push(d.ref);
  }

  // Éléments liés (paiements non aboutis), par groupes pour ne pas saturer Firestore.
  const refs = [...toDelete];
  if (cascade) {
    for (let i = 0; i < toDelete.length; i += 20) {
      const lists = await Promise.all(toDelete.slice(i, i + 20).map(r => cascade(r.id)));
      lists.flat().forEach(r => refs.push(r));
    }
  }
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    refs.slice(i, i + 400).forEach(r => batch.delete(r));
    await batch.commit();
  }

  await db.collection('adminAudit').add({
    action: `delete-${collection}`, adminUid: decoded?.uid || null, mode: Array.isArray(ids) ? 'selection' : 'purge',
    status: Array.isArray(ids) ? null : status, deleted: toDelete.length, linkedDeleted: refs.length - toDelete.length,
    skipped: skipped.length, sampleIds: toDelete.slice(0, 50).map(r => r.id), at: new Date(),
  });
  return { deleted: toDelete.length, linkedDeleted: refs.length - toDelete.length, skipped, more };
}

// Réponse HTTP commune : 400 pour une requête invalide, sinon l'erreur remonte au gestionnaire de la route.
export async function handleDelete(req, res, decoded, collection, cascade) {
  try {
    const r = await adminDelete({ collection, body: req.body, decoded, cascade });
    return res.json({ success: true, ...r });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ success: false, error: e.message });
    console.error('[adminDelete]', e);
    return res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
}
