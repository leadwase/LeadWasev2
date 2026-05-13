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

export default async function handler(req, res) {
  try {
    const { id } = req.query;
    const snap = await db.collection('profiles').doc(id.toUpperCase()).get();
    if (!snap.exists) return res.status(404).json({ error: 'Profil introuvable' });
    const { uid, ...pub } = snap.data();
    res.json({ success: true, profile: pub });
  } catch (e) { res.status(500).json({ error: e.message }); }
}