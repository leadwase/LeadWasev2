// api/get-confirmation.js
// Gère deux routes :
//   GET /api/get-confirmation?orderId=...        → détails commande
//   GET /api/get-confirmation?subscriptionId=... → détails abonnement
//   GET /api/get-confirmation?checkCarte=1       → vérifie si l'utilisateur a une carte (Bearer token requis)

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';
import { getAuth }                       from 'firebase-admin/auth';

if (!getApps().length) {
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  })});
}
const db = getFirestore();

// Convertit un Timestamp Firestore en ms (ou null)
function toMs(ts) {
  if (!ts) return null;
  if (ts._seconds)  return ts._seconds  * 1000;
  if (ts.seconds)   return ts.seconds   * 1000;
  if (ts.toMillis)  return ts.toMillis();
  return null;
}

export default async function handler(req, res) {
  // ── CORS ────────────────────────────────────────────────────────────────
  const origin = process.env.SITE_URL || 'https://leadwase.com';
  res.setHeader('Access-Control-Allow-Origin',  origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).end();

  const { orderId, subscriptionId, checkCarte } = req.query;

  // ── CAS CHECK-CARTE ──────────────────────────────────────────────────────
  // GET /api/get-confirmation?checkCarte=1
  // Header : Authorization: Bearer <idToken>
  if (checkCarte) {
    try {
      const token = (req.headers.authorization || '').split('Bearer ')[1];
      if (!token) return res.status(401).json({ hasCarte: false, error: 'Non autorisé' });

      // Vérifier le token Firebase
      const decoded = await getAuth().verifyIdToken(token);

      // Trouver le profil via firebaseUid
      const profilesSnap = await db.collection('profiles')
        .where('firebaseUid', '==', decoded.uid)
        .limit(1)
        .get();

      if (profilesSnap.empty) {
        return res.json({ hasCarte: false });
      }

      // L'ID du document profil est le leadwaseId (ex: "lw-68518")
      const leadwaseId = profilesSnap.docs[0].id.toUpperCase(); // → "LW-68518"

      // Chercher une commande paid avec ce leadwaseId
      const ordersSnap = await db.collection('orders')
        .where('leadwaseId', '==', leadwaseId)
        .where('status',    '==', 'paid')
        .limit(1)
        .get();

      return res.json({ hasCarte: !ordersSnap.empty });

    } catch (e) {
      console.error('[get-confirmation] checkCarte:', e);
      return res.json({ hasCarte: false });
    }
  }

  if (!orderId && !subscriptionId) {
    return res.status(400).json({ error: 'orderId, subscriptionId ou checkCarte requis' });
  }

  // ── CAS ABONNEMENT ───────────────────────────────────────────────────────
  if (subscriptionId) {
    try {
      const snap = await db.collection('subscriptions').doc(subscriptionId).get();
      if (!snap.exists) return res.status(404).json({ error: 'Abonnement introuvable' });

      const sub = snap.data();
      return res.json({
        type: 'subscription',
        data: {
          plan:        sub.plan        || null,
          amount:      sub.amount      || null,
          status:      sub.status      || null,
          createdAt:   toMs(sub.createdAt),
          activatedAt: toMs(sub.startDate || sub.activatedAt),
          paidAt:      toMs(sub.paidAt),
        },
      });
    } catch (e) {
      console.error('[get-confirmation] abonnement:', e);
      return res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  // ── CAS COMMANDE CARTE ───────────────────────────────────────────────────
  if (orderId) {
    try {
      const snap = await db.collection('orders').doc(orderId).get();
      if (!snap.exists) return res.status(404).json({ error: 'Commande introuvable' });

      const order = snap.data();

      // Credentials — uniquement si paiement confirmé (status === 'paid')
      let credentials = null;
      if (order.leadwaseId && order.status === 'paid') {
        try {
          const credSnap = await db.collection('credentials').doc(order.leadwaseId).get();
          if (credSnap.exists) {
            const c = credSnap.data();
            credentials = {
              leadwaseId:   c.leadwaseId   || c.loginEmail || null,
              passwordHash: c.passwordHash || null,
            };
          }
        } catch (e) {
          console.warn('[get-confirmation] credentials introuvables:', e);
        }
      }

      return res.json({
        type: 'order',
        data: {
          firstName:  order.firstName  || '',
          lastName:   order.lastName   || '',
          phone:      order.phone      || '',
          address:    order.address    || '',
          amount:     order.amount     || null,
          status:     order.status     || '',
          leadwaseId: order.leadwaseId || null,
          createdAt:  toMs(order.createdAt),
        },
        credentials,
      });
    } catch (e) {
      console.error('[get-confirmation] commande:', e);
      return res.status(500).json({ error: 'Erreur serveur' });
    }
  }
}
