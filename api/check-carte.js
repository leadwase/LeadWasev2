import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

if (!getApps().length) {
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  })});
}
const db = getFirestore();

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const token = (req.headers.authorization || '').split('Bearer ')[1];
    if (!token) return res.status(401).json({ hasCarte: false });

    const decoded = await getAuth().verifyIdToken(token);
    
    // Trouver le profil via firebaseUid
    const profilesSnap = await db.collection('profiles')
      .where('firebaseUid', '==', decoded.uid)
      .limit(1).get();

    if (profilesSnap.empty) return res.json({ hasCarte: false });

    const leadwaseId = profilesSnap.docs[0].id.toUpperCase();

    // Chercher commande paid
    const ordersSnap = await db.collection('orders')
      .where('leadwaseId', '==', leadwaseId)
      .where('status', '==', 'paid')
      .limit(1).get();

    return res.json({ hasCarte: !ordersSnap.empty });
  } catch (e) {
    console.error('[check-carte]', e);
    return res.json({ hasCarte: false });
  }
}
