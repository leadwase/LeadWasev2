// setup-admin.js — à exécuter UNE SEULE FOIS après déploiement
// node setup-admin.js
//
// Prérequis : variables d'environnement dans .env.local ou exportées dans le shell
// FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';
import { getAuth }                       from 'firebase-admin/auth';
import { config }                        from 'dotenv';

config({ path: '.env.local' });

if (!getApps().length) {
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  })});
}

const db   = getFirestore();
const auth = getAuth();

const ADMIN_EMAIL    = 'supportleadwase@gmail.com';
const ADMIN_PASSWORD = 'LeadWase@Admin2026!'; // ← change après première connexion

async function setup() {
  console.log('🚀 Création du compte admin Firebase...');

  // 1. Créer le compte Firebase Auth
  let userRecord;
  try {
    userRecord = await auth.createUser({
      email:         ADMIN_EMAIL,
      password:      ADMIN_PASSWORD,
      displayName:   'Admin LeadWase',
      emailVerified: true,
    });
    console.log('✅ Compte Firebase Auth créé :', userRecord.uid);
  } catch (e) {
    if (e.code === 'auth/email-already-exists') {
      userRecord = await auth.getUserByEmail(ADMIN_EMAIL);
      console.log('ℹ️  Compte déjà existant, uid récupéré :', userRecord.uid);
    } else {
      throw e;
    }
  }

  // 2. Écrire le document users/{uid} avec role: 'admin'
  await db.collection('users').doc(userRecord.uid).set({
    email:     ADMIN_EMAIL,
    role:      'admin',
    plan:      'admin',
    createdAt: new Date(),
  }, { merge: true });
  console.log('✅ Document users/' + userRecord.uid + ' créé avec role: admin');

  // 3. Résumé
  console.log('\n─────────────────────────────────────────');
  console.log('🎉 Admin prêt !');
  console.log('   Email    :', ADMIN_EMAIL);
  console.log('   Password :', ADMIN_PASSWORD);
  console.log('   UID      :', userRecord.uid);
  console.log('─────────────────────────────────────────');
  console.log('⚠️  Change le mot de passe après la première connexion.');
}

setup().catch(e => { console.error('❌', e.message); process.exit(1); });
