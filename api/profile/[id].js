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
  
  // Nettoyer l'ID (enlever 'LW-' si présent pour le hash)
  const cleanId = lwId.toString().toUpperCase().replace('LW-', '');
  
  // Générer un hash court à partir de l'ID nettoyé
  let hash = 0;
  for (let i = 0; i < cleanId.length; i++) {
    hash = ((hash << 5) - hash) + cleanId.charCodeAt(i);
    hash |= 0;
  }
  const positiveHash = Math.abs(hash).toString(36).substring(0, 6).toUpperCase();
  return `LW-${positiveHash}`;
}

export default async function handler(req, res) {
  try {
    const { id } = req.query;
    
    if (!id) {
      return res.status(400).json({ error: 'ID manquant' });
    }
    
    const leadwaseId = id.toString().toUpperCase();
    console.log(`🔍 Recherche du profil: ${leadwaseId}`);
    
    // 1. Chercher le profil par son ID de document
    let profileDoc = await db.collection('profiles').doc(leadwaseId).get();
    let profileData = null;
    let actualDocId = leadwaseId;
    
    // 2. Si non trouvé, chercher par le champ leadwaseId
    if (!profileDoc.exists) {
      console.log(`⚠️ Document ${leadwaseId} non trouvé, recherche par champ leadwaseId...`);
      const querySnapshot = await db.collection('profiles')
        .where('leadwaseId', '==', leadwaseId)
        .limit(1)
        .get();
      
      if (!querySnapshot.empty) {
        profileDoc = querySnapshot.docs[0];
        actualDocId = profileDoc.id;
        console.log(`✅ Profil trouvé par leadwaseId: ${actualDocId}`);
      }
    }
    
    // 3. Si non trouvé, chercher par loginEmail ou email
    if (!profileDoc.exists) {
      console.log(`⚠️ Recherche par email...`);
      const emailQuery = await db.collection('profiles')
        .where('loginEmail', '==', `${leadwaseId.toLowerCase()}@leadwase.internal`)
        .limit(1)
        .get();
      
      if (!emailQuery.empty) {
        profileDoc = emailQuery.docs[0];
        actualDocId = profileDoc.id;
        console.log(`✅ Profil trouvé par loginEmail: ${actualDocId}`);
      }
    }
    
    if (!profileDoc.exists) {
      console.log(`❌ Profil non trouvé pour l'ID: ${leadwaseId}`);
      return res.status(404).json({ error: 'Profil introuvable' });
    }
    
    profileData = profileDoc.data();
    console.log(`✅ Profil chargé: ${actualDocId}, plan: ${profileData.plan || 'free'}`);
    
    // Récupérer l'abonnement actif si l'utilisateur a un firebaseUid
    let subscription = null;
    if (profileData.firebaseUid) {
      console.log(`🔍 Recherche d'abonnement pour firebaseUid: ${profileData.firebaseUid}`);
      
      const subQuery = await db.collection('subscriptions')
        .where('uid', '==', profileData.firebaseUid)
        .where('status', '==', 'active')
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get();
      
      if (!subQuery.empty) {
        const subDoc = subQuery.docs[0];
        const subData = subDoc.data();
        subscription = {
          id: subDoc.id,
          plan: subData.plan,
          status: subData.status,
          startDate: subData.startDate,
          expiryDate: subData.expiryDate,
          amount: subData.amount
        };
        console.log(`✅ Abonnement actif trouvé: ${subData.plan}`);
        
        // Si l'abonnement est actif mais le profil est encore "free", mettre à jour
        if (profileData.plan !== subData.plan && subData.plan !== 'free') {
          console.log(`⚠️ Mise à jour du plan: ${profileData.plan} → ${subData.plan}`);
          await profileDoc.ref.update({ 
            plan: subData.plan,
            updatedAt: new Date()
          });
          profileData.plan = subData.plan;
        }
      } else {
        console.log(`ℹ️ Aucun abonnement actif trouvé pour cet utilisateur`);
      }
    } else {
      console.log(`ℹ️ Pas de firebaseUid associé au profil`);
    }
    
    // Exclure les champs sensibles
    const { uid, firebaseUid, ...publicProfile } = profileData;
    
    // Ajouter le code public
    const publicCode = getPublicCode(actualDocId);
    
    // Ajouter les infos d'abonnement si disponibles
    const response = {
      success: true,
      profile: publicProfile,
      publicCode: publicCode,
      plan: profileData.plan || 'free'
    };
    
    if (subscription) {
      response.subscription = subscription;
    }
    
    res.json(response);
    
  } catch (e) { 
    console.error('❌ Erreur API profil:', e);
    res.status(500).json({ error: e.message }); 
  }
}
