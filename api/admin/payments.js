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

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  try {
    await verifyToken(req);
    const snap = await db.collection('payments')
      .orderBy('createdAt', 'desc')
      .limit(200)
      .get();

    const payments = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.json({ success: true, payments });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
