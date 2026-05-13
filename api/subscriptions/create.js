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
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const user   = await verifyToken(req);
    const { plan } = req.body;
    const prices = { pro: 2999, business: 4566 };
    const amount = prices[plan];
    if (!amount) return res.status(400).json({ error: 'Plan invalide' });

    const subRef = await db.collection('subscriptions').add({
      uid: user.uid, plan, amount, status: 'pending', createdAt: new Date(),
    });
    const payRef = await db.collection('payments').add({
      uid: user.uid, subscriptionId: subRef.id, amount, status: 'pending', createdAt: new Date(),
    });

    const GW_URL = 'https://paymentgateway.lfdweb.com';
    const SITE   = process.env.SITE_URL || 'https://leadwase.com';
    const gRes   = await fetch(`${GW_URL}/api/gateway/generate-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.GATEWAY_API_KEY },
      body: JSON.stringify({
        amount, country: 'bj',
        description: `LeadWase ${plan.toUpperCase()} — 1 mois`,
        origin: SITE, sendWebhook: true,
        metadata: { transactionId: payRef.id, subscriptionId: subRef.id, plan, uid: user.uid, origin: SITE, sendWebhook: true },
      }),
    });
    const gData = await gRes.json();
    await payRef.update({ pid: gData.pid });
    await subRef.update({ paymentId: payRef.id, pid: gData.pid });
    res.json({ success: true, payUrl: gData.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
}