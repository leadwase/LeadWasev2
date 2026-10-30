import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';
import { limitOrReject }                 from '../../lib/rateLimit.js';

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
  try { return await getAuth().verifyIdToken(token); }
  catch { throw new Error('Non autorisé'); }     // jeton invalide ou expiré
}

const RANK = { free: 0, pro: 1, business: 2 };

// POST /api/subscriptions/create  { plan: 'pro'|'business', duration?: 1|3|6|12, scope?: 'team' }
//  • abonnement individuel : prix mensuel × durée (remises 3/6/12 mois)
//  • abonnement ÉQUIPE (B2B) : UN seul abonnement annuel pour l'équipe ET le chef d'équipe, au tarif entreprise
//    (Admin → Paramètres). Réservé au chef d'équipe ; le plan s'applique au chef et à tous les comptes de l'équipe.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (await limitOrReject(req, res, 'sub-create', 15, 3600)) return;
  try {
    const user = await verifyToken(req);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const plan = String(body.plan || '');
    if (!['pro', 'business'].includes(plan)) return res.status(400).json({ error: 'Plan invalide' });

    const profSnap = await db.collection('profiles').where('firebaseUid', '==', user.uid).limit(1).get();
    const profileDoc = profSnap.empty ? null : profSnap.docs[0];
    const profile = profileDoc ? profileDoc.data() : {};

    // Un compte employé ne souscrit pas : l'abonnement de l'équipe est géré par le chef d'équipe.
    if (profile.parentLeadwaseId) {
      return res.status(403).json({ error: "L'abonnement de votre équipe est géré par votre chef d'équipe." });
    }
    // Un chef d'équipe souscrit toujours pour l'équipe entière.
    const isTeam = body.scope === 'team' || profile.isTeamOwner === true;
    if (isTeam && profile.isTeamOwner !== true) {
      return res.status(403).json({ error: "Seul le chef d'équipe peut souscrire l'abonnement de l'équipe." });
    }

    const { getPrices } = await import('../../lib/getPrices.js');
    const prices = await getPrices();
    let amount, durationMonths;

    if (isTeam) {
      if (RANK[plan] < RANK[profile.plan || 'free']) {
        return res.status(400).json({ error: 'Votre équipe dispose déjà d\'un forfait supérieur.' });
      }
      amount = plan === 'pro' ? prices.b2bPro : prices.b2bBusiness;
      durationMonths = 12;
    } else {
      const monthly = prices[plan];
      const DURATIONS = { 1: 0, 3: 0.05, 6: 0.10, 12: 0.15 };
      durationMonths = Object.prototype.hasOwnProperty.call(DURATIONS, body.duration) ? Number(body.duration) : 1;
      amount = Math.round(monthly * durationMonths * (1 - DURATIONS[durationMonths]));
    }
    if (!amount || amount < 1) return res.status(400).json({ error: 'Plan invalide' });

    const subRef = await db.collection('subscriptions').add({
      uid: user.uid, plan, amount, durationMonths, status: 'pending', createdAt: new Date(),
      ...(isTeam ? { scope: 'team', teamOwnerId: profileDoc.id } : {}),
    });
    const payRef = await db.collection('payments').add({
      uid: user.uid, subscriptionId: subRef.id, amount, status: 'pending', createdAt: new Date(),
    });

    const GW_URL = 'https://paymentgateway.lfdweb.com';
    const SITE   = process.env.SITE_URL || 'https://leadwase.com';
    const durationLabel = isTeam ? '1 an — équipe entière' : durationMonths === 1 ? '1 mois' : durationMonths === 12 ? '1 an' : `${durationMonths} mois`;
    const gRes   = await fetch(`${GW_URL}/api/gateway/generate-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.GATEWAY_API_KEY },
      body: JSON.stringify({
        amount, country: 'bj',
        description: `LeadWase ${plan.toUpperCase()}${isTeam ? ' Entreprise' : ''} — ${durationLabel}`,
        origin: SITE, sendWebhook: true,
        metadata: { transactionId: payRef.id, subscriptionId: subRef.id, plan, uid: user.uid, origin: SITE, sendWebhook: true },
      }),
    });
    const gRaw = await gRes.text();
    let gData;
    try { gData = JSON.parse(gRaw); } catch { gData = {}; }

    // Firestore interdit les valeurs undefined dans update() : on vérifie pid/url avant.
    if (!gRes.ok || !gData.pid || !gData.url) {
      await subRef.update({ status: 'gateway_error', gatewayResponse: gRaw.slice(0, 500) });
      console.error('[subscriptions] passerelle refusée', gRes.status);
      return res.status(502).json({ error: 'La passerelle de paiement a refusé la demande. Réessayez ou contactez le support.' });
    }

    await payRef.update({ pid: gData.pid });
    await subRef.update({ paymentId: payRef.id, pid: gData.pid });
    res.json({ success: true, payUrl: gData.url, subscriptionId: subRef.id, amount, scope: isTeam ? 'team' : 'individual' });

  } catch (e) {
    const code = e.message === 'Non autorisé' ? 401 : 500;
    if (code === 500) console.error('[subscriptions]', e.message);
    res.status(code).json({ error: code === 401 ? 'Non autorisé' : 'Erreur serveur' });
  }
}
