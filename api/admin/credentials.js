// api/admin/credentials.js
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

// ✅ INITIALISATION - À AJOUTER ABSOLUMENT
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    })
  });
}

const db = getFirestore();

export default async function handler(req, res) {
  // 1. Vérifier l'authentification
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Non authentifié' });
  }
  
  const token = authHeader.split('Bearer ')[1];
  try {
    await getAuth().verifyIdToken(token);
  } catch (e) {
    return res.status(403).json({ success: false, error: 'Token invalide' });
  }

  try {
    // 2. Lire tous les documents de la collection "credentials"
    const credentialsSnapshot = await db.collection('credentials').get();
    
    const credentials = [];
    
    for (const doc of credentialsSnapshot.docs) {
      const credData = doc.data();
      const leadwaseId = credData.leadwaseId || doc.id;
      
      // Récupérer les infos du profil correspondant
      let profile = null;
      try {
        const profileDoc = await db.collection('profiles').doc(leadwaseId).get();
        if (profileDoc.exists) profile = profileDoc.data();
      } catch(e) { 
        console.warn('Profil manquant pour', leadwaseId); 
      }
      
      credentials.push({
        leadwaseId: leadwaseId,
        login: leadwaseId,
        password: credData.passwordHash || credData.password || '—',
        email: profile?.email || '—',
        clientName: profile ? `${profile.firstName || ''} ${profile.lastName || ''}`.trim() : '—',
        createdAt: credData.createdAt || null,
      });
    }
    
    return res.status(200).json({ success: true, credentials });
    
  } catch (error) {
    console.error('Erreur API credentials:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}
