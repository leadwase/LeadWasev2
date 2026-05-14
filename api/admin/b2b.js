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

async function verifyAdmin(req) {
  const token = (req.headers.authorization || '').split('Bearer ')[1];
  if (!token) throw new Error('Non autorisé');
  const decoded = await getAuth().verifyIdToken(token);
  const u = await db.collection('users').doc(decoded.uid).get();
  if (u.data()?.role !== 'admin') throw new Error('Accès refusé');
}

export default async function handler(req, res) {
  try {
    await verifyAdmin(req);

    // Sans orderBy pour éviter le besoin d'index — on trie côté serveur
    const snap = await db.collection('orders')
      .where('cardType', '==', 'b2b')
      .get();

    const orders = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const ta = a.createdAt?._seconds || 0;
        const tb = b.createdAt?._seconds || 0;
        return tb - ta;
      });

    res.json({ success: true, orders });
  } catch (e) {
    console.error('[admin/b2b]', e.message);
    res.status(500).json({ error: e.message });
  }
}
