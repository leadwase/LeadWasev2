// Fichier : api/admin/credentials.js (ou .ts)

import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

const db = getFirestore();

export default async function handler(req, res) {
  // 1. Vérification de l'authentification admin
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Non authentifié' });
  }
  
  const token = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await getAuth().verifyIdToken(token);
    // Optionnel : vérifier que l'email est bien admin
    // if (decodedToken.email !== 'votre-email-admin@example.com') throw new Error();
  } catch (e) {
    return res.status(403).json({ success: false, error: 'Token invalide' });
  }

  try {
    // 2. Récupérer tous les profils (utilisateurs avec leadwaseId)
    const profilesSnapshot = await db.collection('profiles').get();
    
    const credentials = [];
    
    for (const profileDoc of profilesSnapshot.docs) {
      const profile = profileDoc.data();
      
      // Récupérer le mot de passe depuis la collection 'credentials'
      const credDoc = await db.collection('credentials').doc(profile.leadwaseId).get();
      const credData = credDoc.exists ? credDoc.data() : {};
      
      credentials.push({
        leadwaseId: profile.leadwaseId,
        login: profile.leadwaseId, // L'identifiant = leadwaseId
        password: credData.passwordHash || '(mot de passe non disponible)',
        email: profile.email || '',
        clientName: `${profile.firstName || ''} ${profile.lastName || ''}`.trim() || '—',
        createdAt: profile.createdAt,
      });
    }
    
    return res.status(200).json({
      success: true,
      credentials: credentials
    });
    
  } catch (error) {
    console.error('Erreur API credentials:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Erreur interne du serveur' 
    });
  }
}
