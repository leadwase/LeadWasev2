import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

if (!getApps().length) {
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  })});
}
const db = getFirestore();

// ── Prospects ("Mes Prospects" / bouton "Échanger" du profil public) ─────────
// Regroupées ici (plutôt que dans un fichier api/ séparé) pour rester sous la
// limite de 12 fonctions serverless du plan Vercel Hobby.

// Vérifie que le token envoyé correspond bien au propriétaire du profil `leadwaseId`.
// Plusieurs signaux sont acceptés (l'écriture de firebaseUid au premier login peut
// échouer silencieusement selon connexion.html) : firebaseUid, uid, email interne,
// et en dernier recours users/{uid}.leadwaseId.
async function verifyOwner(req, leadwaseId) {
  const token = (req.headers.authorization || '').split('Bearer ')[1];
  if (!token) throw new Error('Non autorisé');

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(token);
  } catch (e) {
    console.error('[verifyOwner] verifyIdToken a échoué:', e.message);
    throw new Error('Session invalide, merci de vous reconnecter');
  }

  const profileDoc = await db.collection('profiles').doc(leadwaseId).get();
  if (!profileDoc.exists) throw new Error('Accès refusé');
  const pd = profileDoc.data();

  const ownsByFirebaseUid = pd.firebaseUid && pd.firebaseUid === decoded.uid;
  const ownsByUid         = pd.uid && pd.uid === decoded.uid;
  const ownsByEmail       = decoded.email &&
    decoded.email.toLowerCase() === `${leadwaseId.toLowerCase()}@leadwase.internal`;

  let ownsByUsersDoc = false;
  if (!ownsByFirebaseUid && !ownsByUid && !ownsByEmail) {
    const uDoc = await db.collection('users').doc(decoded.uid).get();
    ownsByUsersDoc = uDoc.exists && uDoc.data()?.leadwaseId === leadwaseId;
  }

  if (!ownsByFirebaseUid && !ownsByUid && !ownsByEmail && !ownsByUsersDoc) {
    console.error(`[verifyOwner] Accès refusé pour uid=${decoded.uid} sur profil ${leadwaseId}`);
    throw new Error('Accès refusé');
  }

  // Répare le profil au passage si firebaseUid manquait (évite de retomber sur ce bug).
  if (!pd.firebaseUid) {
    await profileDoc.ref.set({ firebaseUid: decoded.uid }, { merge: true }).catch(() => {});
  }

  return decoded;
}

// POST /api/profile/[id]?action=capture-lead — public, appelé depuis le bouton
// "Échanger" de la page profil publique. N'importe quel visiteur peut soumettre
// ses coordonnées ; aucune authentification requise (comme un formulaire de contact).
async function captureLead(req, res, leadwaseId) {
  const { name, phone, email, object, source } = req.body || {};
  if (!name || (!phone && !email)) {
    return res.status(400).json({ success: false, error: 'Nom et (téléphone ou email) requis' });
  }
  await db.collection('prospects').add({
    ownerId:   leadwaseId,
    name:      String(name).trim().slice(0, 120),
    phone:     phone  ? String(phone).trim().slice(0, 40)  : '',
    email:     email  ? String(email).trim().slice(0, 120) : '',
    object:    object ? String(object).trim().slice(0, 300) : '',
    source:    source === 'nfc' ? 'nfc' : 'lien_direct',
    createdAt: new Date(),
  });
  res.json({ success: true });
}

// POST /api/profile/[id]?action=submit-contact-form — public, formulaire de contact
// personnalisé du profil public. Enregistre un prospect ET notifie le propriétaire par email.
async function submitContactForm(req, res, leadwaseId) {
  const { values, source } = req.body || {};
  if (!values || typeof values !== 'object' || !Object.keys(values).length) {
    return res.status(400).json({ success: false, error: 'Formulaire vide' });
  }

  const profileDoc = await db.collection('profiles').doc(leadwaseId).get();
  if (!profileDoc.exists) return res.status(404).json({ success: false, error: 'Profil introuvable' });
  const p = profileDoc.data();

  // Tente de retrouver un nom/téléphone/email dans les champs soumis pour l'annuaire prospects.
  const entries = Object.entries(values);
  const findByKeyword = (words) => {
    const hit = entries.find(([label]) => words.some(w => label.toLowerCase().includes(w)));
    return hit ? String(hit[1]).trim().slice(0, 120) : '';
  };
  const name  = findByKeyword(['nom', 'name'])   || 'Visiteur formulaire';
  const phone = findByKeyword(['tel', 'phone']);
  const email = findByKeyword(['email', 'mail']);
  const object = entries.map(([label, val]) => `${label} : ${val}`).join(' — ').slice(0, 500);

  await db.collection('prospects').add({
    ownerId:   leadwaseId,
    name, phone, email, object,
    source:    source === 'nfc' ? 'nfc' : 'lien_direct',
    viaForm:   true,
    createdAt: new Date(),
  });

  if (p.email) {
    try {
      const { notifyOwnerContactForm } = await import('../../lib/brevo.js');
      await notifyOwnerContactForm({
        ownerEmail: p.email,
        ownerName:  p.firstName || '',
        leadwaseId,
        values,
      });
    } catch (e) {
      console.error('[submitContactForm] envoi email échoué:', e.message);
      // On ne bloque pas la réponse au visiteur si l'email échoue — le prospect est déjà enregistré.
    }
  }

  res.json({ success: true });
}

// GET /api/profile/[id]?action=prospects — authentifié (propriétaire uniquement).
async function listProspects(req, res, leadwaseId) {
  await verifyOwner(req, leadwaseId);
  const snap = await db.collection('prospects')
    .where('ownerId', '==', leadwaseId)
    .orderBy('createdAt', 'desc')
    .limit(500)
    .get();
  const prospects = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  res.json({ success: true, prospects });
}

// DELETE /api/profile/[id]?action=prospects&prospectId=xxx — authentifié.
async function deleteProspect(req, res, leadwaseId) {
  await verifyOwner(req, leadwaseId);
  const { prospectId } = req.query;
  if (!prospectId) return res.status(400).json({ success: false, error: 'prospectId requis' });
  const ref = db.collection('prospects').doc(prospectId);
  const doc = await ref.get();
  if (!doc.exists || doc.data().ownerId !== leadwaseId) {
    return res.status(404).json({ success: false, error: 'Prospect introuvable' });
  }
  await ref.delete();
  res.json({ success: true });
}

// POST /api/profile/[id]?action=clear-prospects — authentifié, vide tout l'annuaire.
async function clearProspects(req, res, leadwaseId) {
  await verifyOwner(req, leadwaseId);
  const snap = await db.collection('prospects').where('ownerId', '==', leadwaseId).get();
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  res.json({ success: true, deleted: snap.size });
}

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

// GET /api/profile/[id]?action=google-reviews — public. Récupère la note +
// les derniers avis Google via l'API Google Places (Place Details), avec un
// cache Firestore de 6h pour limiter le coût des appels API.
const REVIEWS_CACHE_MS = 6 * 60 * 60 * 1000;

async function getGoogleReviews(req, res, leadwaseId) {
  const profileDoc = await db.collection('profiles').doc(leadwaseId).get();
  if (!profileDoc.exists) return res.status(404).json({ success: false, error: 'Profil introuvable' });
  const p = profileDoc.data();

  if (!p.googlePlaceId) {
    return res.json({ success: true, configured: false });
  }

  const cache = p.reviewsCache;
  if (cache && cache.fetchedAt && (Date.now() - cache.fetchedAt) < REVIEWS_CACHE_MS) {
    return res.json({ success: true, configured: true, ...cache.data, cached: true });
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    // Pas de clé configurée côté serveur : on retourne le cache existant (même expiré) si dispo.
    if (cache?.data) return res.json({ success: true, configured: true, ...cache.data, cached: true, stale: true });
    return res.json({ success: false, configured: true, error: 'GOOGLE_PLACES_API_KEY non configurée côté serveur' });
  }

  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(p.googlePlaceId)}&fields=rating,user_ratings_total,reviews,url&language=fr&key=${apiKey}`;
  const r = await fetch(url);
  const d = await r.json();
  if (d.status !== 'OK') {
    console.error('[getGoogleReviews] Places API error:', d.status, d.error_message);
    if (cache?.data) return res.json({ success: true, configured: true, ...cache.data, cached: true, stale: true });
    return res.json({ success: false, configured: true, error: d.error_message || d.status });
  }

  const data = {
    rating:      d.result.rating || 0,
    totalRatings: d.result.user_ratings_total || 0,
    mapsUrl:     d.result.url || '',
    reviews: (d.result.reviews || []).slice(0, 5).map(rv => ({
      author: rv.author_name, rating: rv.rating, text: rv.text,
      relativeTime: rv.relative_time_description, profilePhoto: rv.profile_photo_url,
    })),
  };

  await profileDoc.ref.set({ reviewsCache: { data, fetchedAt: Date.now() } }, { merge: true });
  res.json({ success: true, configured: true, ...data });
}

export default async function handler(req, res) {
  try {
    const { id } = req.query;
    
    if (!id) {
      return res.status(400).json({ error: 'ID manquant' });
    }
    
    const leadwaseId = id.toString().toUpperCase();

    // ── Routage des actions "prospects" (CRM) ───────────────────────────────
    const action = req.query.action;
    if (action === 'capture-lead' && req.method === 'POST') {
      return captureLead(req, res, leadwaseId).catch(e =>
        res.status(500).json({ success: false, error: e.message }));
    }
    if (action === 'submit-contact-form' && req.method === 'POST') {
      return submitContactForm(req, res, leadwaseId).catch(e =>
        res.status(500).json({ success: false, error: e.message }));
    }
    if (action === 'prospects' && req.method === 'GET') {
      return listProspects(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'prospects' && req.method === 'DELETE') {
      return deleteProspect(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'clear-prospects' && req.method === 'POST') {
      return clearProspects(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'google-reviews' && req.method === 'GET') {
      return getGoogleReviews(req, res, leadwaseId).catch(e =>
        res.status(500).json({ success: false, error: e.message }));
    }

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
