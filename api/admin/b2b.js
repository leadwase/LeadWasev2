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
    const snap = await db.collection('orders')
      .where('cardType', '==', 'b2b')
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();
    res.json({ success: true, orders: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
