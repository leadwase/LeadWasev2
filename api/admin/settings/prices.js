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

async function verifyToken(req) {
  const { getAuth } = await import('firebase-admin/auth');
  const token = (req.headers.authorization || '').split('Bearer ')[1];
  if (!token) throw new Error('Non autorisé');
  return getAuth().verifyIdToken(token);
}

// Prix par défaut si le document n'existe pas encore
const DEFAULT_PRICES = { classic: 25000, pro: 3500, business: 9900 };

export default async function handler(req, res) {
  try {
    await verifyToken(req);
    const ref = db.collection('settings').doc('prices');

    // ── GET : lire les prix ──────────────────────────────────────
    if (req.method === 'GET') {
      const snap = await ref.get();
      const prices = snap.exists ? snap.data() : DEFAULT_PRICES;
      return res.json({ success: true, prices });
    }

    // ── POST : sauvegarder les prix ──────────────────────────────
    if (req.method === 'POST') {
      const { prices } = req.body;
      if (!prices || typeof prices !== 'object') {
        return res.status(400).json({ success: false, error: 'Corps invalide : { prices: { classic, pro, business } }' });
      }

      const classic  = parseInt(prices.classic)  || 0;
      const pro      = parseInt(prices.pro)       || 0;
      const business = parseInt(prices.business)  || 0;

      if (classic <= 0 || pro <= 0 || business <= 0) {
        return res.status(400).json({ success: false, error: 'Tous les prix doivent être > 0' });
      }

      await ref.set({ classic, pro, business, updatedAt: new Date() }, { merge: true });
      return res.json({ success: true, prices: { classic, pro, business } });
    }

    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
