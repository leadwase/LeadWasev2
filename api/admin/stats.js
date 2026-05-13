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
  return decoded;
}

export default async function handler(req, res) {
  try {
    await verifyAdmin(req);
    const [orders, payments, subs] = await Promise.all([
      db.collection('orders').get(),
      db.collection('payments').where('status','==','success').get(),
      db.collection('subscriptions').where('status','==','active').get(),
    ]);
    const pending = orders.docs.filter(d => ['pending','paid'].includes(d.data().status)).length;
    const revenue = payments.docs.reduce((a, d) => a + (d.data().amount || 0), 0);
    res.json({ success: true, stats: { totalOrders: orders.size, totalRevenue: revenue, activeSubscriptions: subs.size, pendingOrders: pending } });
  } catch (e) { res.status(e.message === 'Accès refusé' ? 403 : 500).json({ error: e.message }); }
}