import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  })});
}
const db = getFirestore();

// Plus besoin de vérifier le token — les commandes sont ouvertes sans connexion
// async function verifyToken(req) {
//   const { getAuth } = await import('firebase-admin/auth');
//   const token = (req.headers.authorization || '').split('Bearer ')[1];
//   if (!token) throw new Error('Non autorisé');
//   return getAuth().verifyIdToken(token);
// }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    // Plus besoin d'authentifier l'utilisateur
    // const user = await verifyToken(req);

    const { cardType, firstName, lastName, jobTitle, company, phone, email, address } = req.body;
    const amount = 2500;

    const orderRef = await db.collection('orders').add({
      // uid: user.uid,  // plus de uid puisque pas de connexion obligatoire
      cardType, firstName, lastName, jobTitle, company, phone, email, address,
      amount: cardType === 'classic' ? amount : null,
      status: 'pending',
      createdAt: new Date(),
    });

    if (cardType === 'b2b') return res.json({ success: true, orderId: orderRef.id, type: 'b2b' });

    const payRef = await db.collection('payments').add({
      // uid: user.uid,  // plus de uid puisque pas de connexion obligatoire
      orderId: orderRef.id, amount, status: 'pending', createdAt: new Date(),
    });

    const GW_URL = 'https://paymentgateway.lfdweb.com';
    const SITE   = process.env.SITE_URL || 'https://leadwase.com';
    const gRes   = await fetch(`${GW_URL}/api/gateway/generate-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.GATEWAY_API_KEY },
      body: JSON.stringify({
        amount, country: 'bj',
        description: `Carte LeadWase — ${firstName} ${lastName}`,
        origin: SITE, sendWebhook: true,
        metadata: {
          transactionId: payRef.id, orderId: orderRef.id,
          // uid: user.uid,  // plus de uid puisque pas de connexion obligatoire
          origin: SITE, sendWebhook: true,
        },
      }),
    });

    // Log du statut HTTP brut pour détecter les erreurs 4xx/5xx de la gateway
    console.log('[gateway http status]', gRes.status);

    // Lire le body en texte brut d'abord — même en cas d'erreur HTTP — pour avoir le message complet
    const gRaw = await gRes.text();
    console.log('[gateway response raw]', gRaw);

    // Parser en JSON, avec fallback si le body n'est pas du JSON valide
    let gData;
    try { gData = JSON.parse(gRaw); }
    catch { gData = { raw: gRaw }; }

    // Vérifier que la gateway a bien renvoyé pid et url avant tout update()
    // Firestore interdit les valeurs undefined dans update() — erreur si pid/url absent
    if (!gRes.ok || !gData.pid || !gData.url) {
      await orderRef.update({ status: 'gateway_error', gatewayResponse: gRaw.slice(0, 500) });
      return res.status(502).json({
        error: `Gateway ${gRes.status} — ${gData.message || gData.error || 'réponse invalide'}`,
        detail: gData,
      });
    }

    await payRef.update({ pid: gData.pid, payUrl: gData.url });
    await orderRef.update({ paymentId: payRef.id, pid: gData.pid });
    res.json({ success: true, orderId: orderRef.id, payUrl: gData.url });

  } catch (e) { res.status(500).json({ error: e.message }); }
}
