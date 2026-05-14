import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  })});
}
const db = getFirestore();

// Fonction pour transformer l'ID réel en code public
function getPublicCode(lwId) {
  if (!lwId) return 'LW-????';
  
  // Générer un hash court à partir de l'ID complet
  let hash = 0;
  for (let i = 0; i < lwId.length; i++) {
    hash = ((hash << 5) - hash) + lwId.charCodeAt(i);
    hash |= 0;
  }
  const positiveHash = Math.abs(hash).toString(36).substring(0, 6).toUpperCase();
  return `LW-${positiveHash}`;
}

export default async function handler(req, res) {
  try {
    const { id } = req.query;
    const snap = await db.collection('profiles').doc(id.toUpperCase()).get();
    
    if (!snap.exists) return res.status(404).json({ error: 'Profil introuvable' });
    
    const { uid, ...pub } = snap.data();
    
    // Ajouter le code public à la réponse
    const publicCode = getPublicCode(id.toUpperCase());
    
    res.json({ 
      success: true, 
      profile: pub,
      publicCode: publicCode  // Le code public à afficher
    });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
}
