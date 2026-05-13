import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp }       from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  })});
}
const db = getFirestore();

function genId()  { return 'LW-' + Math.floor(10000 + Math.random() * 90000); }
function genPwd(n = 10) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#!';
  return Array.from({ length: n }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { event, transaction } = req.body;
    const raw = (transaction?.status || event || '').toLowerCase();
    const ok  = ['successful','success','completed','paid','payment.completed'].includes(raw);
    const ko  = ['failed','failure','cancelled','rejected','payment.failed'].includes(raw);
    if (!ok && !ko) return res.json({ received: true, status: 'ignored' });

    let payDoc = null;
    const txId = transaction?.metadata?.transactionId;
    if (txId) { const d = await db.collection('payments').doc(txId).get(); if (d.exists) payDoc = d; }

    if (!payDoc) {
      const ref = transaction?.reference || transaction?.id;
      if (ref) { const s = await db.collection('payments').where('pid','==',ref).limit(1).get(); if (!s.empty) payDoc = s.docs[0]; }
    }

    if (!payDoc && transaction?.amount) {
      const s = await db.collection('payments')
        .where('status','==','pending').where('amount','==',transaction.amount)
        .orderBy('createdAt','desc').limit(1).get();
      if (!s.empty) payDoc = s.docs[0];
    }

    if (!payDoc) return res.json({ received: true });
    const pay = payDoc.data();
    if (pay.status === 'success') return res.json({ received: true });

    const status = ok ? 'success' : 'failed';
    await payDoc.ref.update({ status, gatewayRef: transaction?.reference, webhookVerified: true, updatedAt: new Date() });

    if (ok && pay.orderId) {
      const ord  = await db.collection('orders').doc(pay.orderId).get();
      const oData = ord.data();
      let lwId = genId();
      const ex = await db.collection('profiles').where('leadwaseId','==',lwId).get();
      if (!ex.empty) lwId = genId();
      const pwd = genPwd();
      await ord.ref.update({ status: 'paid', leadwaseId: lwId, paidAt: new Date() });
      await db.collection('profiles').doc(lwId).set({ uid: pay.uid, leadwaseId: lwId, firstName: oData.firstName, lastName: oData.lastName, jobTitle: oData.jobTitle, company: oData.company, phone: oData.phone, email: oData.email, plan: 'free', createdAt: new Date() });
      await db.collection('credentials').doc(lwId).set({ uid: pay.uid, leadwaseId: lwId, passwordHash: pwd, createdAt: new Date() });
      await db.collection('users').doc(pay.uid).set({ leadwaseId: lwId, plan: 'free', updatedAt: new Date() }, { merge: true });
    }

    if (ok && pay.subscriptionId) {
      const sub  = await db.collection('subscriptions').doc(pay.subscriptionId).get();
      const sData = sub.data();
      const exp  = new Date(); exp.setMonth(exp.getMonth() + 1);
      await sub.ref.update({ status: 'active', startDate: new Date(), expiryDate: Timestamp.fromDate(exp) });
      await db.collection('users').doc(pay.uid).update({ plan: sData.plan, planExpiry: Timestamp.fromDate(exp), updatedAt: new Date() });
      const uDoc = await db.collection('users').doc(pay.uid).get();
      if (uDoc.data()?.leadwaseId) await db.collection('profiles').doc(uDoc.data().leadwaseId).update({ plan: sData.plan });
    }

    res.json({ received: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
}