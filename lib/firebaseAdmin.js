// lib/firebaseAdmin.js
// Initialisation Firebase Admin partagée + helpers d'authentification,
// utilisés par toutes les routes API (api/**).

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

export const db = getFirestore();

// Vérifie qu'un token Firebase valide est présent (utilisateur connecté).
export async function verifyToken(req) {
  const token = (req.headers.authorization || '').split('Bearer ')[1];
  if (!token) throw new Error('Non autorisé');
  return getAuth().verifyIdToken(token);
}

// Vérifie que l'utilisateur connecté a le rôle admin (users/{uid}.role === 'admin').
export async function verifyAdmin(req) {
  const decoded = await verifyToken(req);
  const u = await db.collection('users').doc(decoded.uid).get();
  if (u.data()?.role !== 'admin') throw new Error('Accès refusé');
  return decoded;
}

// En-têtes CORS pour les routes admin : uniquement les origines du site (jamais de joker « * »).
const ALLOWED_ORIGINS = new Set([
  'https://leadwase.com', 'https://www.leadwase.com',
  ...(process.env.SITE_URL ? [process.env.SITE_URL.replace(/\/$/, '')] : []),
]);
export function setCors(res, req) {
  const origin = req?.headers?.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}
