import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';
import { getAuth }                       from 'firebase-admin/auth';
import {
  notifyClientCredentials,
} from '../brevo.js';

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

async function verifyAdmin(req) {
  const token = (req.headers.authorization || '').split('Bearer ')[1];
  if (!token) throw new Error('Non autorisé');
  const decoded = await getAuth().verifyIdToken(token);
  const u = await db.collection('users').doc(decoded.uid).get();
  if (u.data()?.role !== 'admin') throw new Error('Accès refusé');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    await verifyAdmin(req);

    const { orderId } = req.body;
    const order = await db.collection('orders').doc(orderId).get();
    if (!order.exists) return res.status(404).json({ error: 'Commande introuvable' });

    const d = order.data();

    // Identifiants déjà générés — on les retourne sans recréer
    if (d.leadwaseId) return res.json({ success: true, leadwaseId: d.leadwaseId, alreadyCreated: true });

    let lwId = genId();
    const ex = await db.collection('profiles').where('leadwaseId','==',lwId).get();
    if (!ex.empty) lwId = genId();
    const pwd = genPwd();

    await db.collection('profiles').doc(lwId).set({
      // uid: d.uid,  // pas de uid — commande passée sans connexion obligatoire
      leadwaseId: lwId,
      firstName:  d.firstName,
      lastName:   d.lastName,
      jobTitle:   d.jobTitle,
      company:    d.company,
      phone:      d.phone,
      email:      d.email,
      plan:       'free',
      createdAt:  new Date(),
    });

    await db.collection('credentials').doc(lwId).set({
      // uid: d.uid,  // pas de uid — commande passée sans connexion obligatoire
      leadwaseId:   lwId,
      passwordHash: pwd,
      createdAt:    new Date(),
    });

    // Mise à jour users désactivée — pas de compte Firebase lié à la commande
    // await db.collection('users').doc(d.uid).set({ leadwaseId: lwId, plan: 'free' }, { merge: true });

    await order.ref.update({ status: 'delivered', leadwaseId: lwId });

    // Envoi des identifiants au client par email
    await notifyClientCredentials({
      firstName:  d.firstName,
      email:      d.email,
      leadwaseId: lwId,
      password:   pwd,
    });

    res.json({ success: true, leadwaseId: lwId, password: pwd });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
