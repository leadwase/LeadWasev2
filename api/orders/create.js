import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';
import { notifyAdminNewOrder, notifyAdminB2BRequest, notifyClientPaymentSuccess } from '../brevo.js';

if (!getApps().length) {
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  })});
}
const db = getFirestore();

// Plus besoin de vérifier le token — les commandes sont ouvertes sans connexion
// async function verifyToken(req) { ... }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { cardType, firstName, lastName, jobTitle, company, phone, email, address, quantity, description } = req.body;

    // ── Commande B2B — enregistrement + email admin ────────────────
    if (cardType === 'b2b') {
      const orderRef = await db.collection('orders').add({
        cardType:    'b2b',
        firstName,
        company,
        phone:       phone || '',
        email,
        quantity:    quantity || '',
        description: description || '',
        status:      'b2b_pending',   // statut distinct pour l'onglet B2B dans le dashboard
        amount:      null,
        createdAt:   new Date(),
      });

      // Notif email admin — demande B2B
      await notifyAdminB2BRequest({
        orderId:     orderRef.id,
        company,
        name:        firstName,
        email,
        phone:       phone || '—',
        quantity:    quantity || '—',
        description: description || '—',
      }).catch(e => console.error('[brevo b2b]', e.message));

      return res.json({ success: true, orderId: orderRef.id, type: 'b2b' });
    }

    // ── Commande Classique ─────────────────────────────────────────
    const amount   = 2500;
    const orderRef = await db.collection('orders').add({
      // uid: user.uid,  // plus de uid — commande sans connexion obligatoire
      cardType, firstName, lastName, jobTitle, company, phone, email, address,
      amount,
      status:    'pending',
      createdAt: new Date(),
    });

    const payRef = await db.collection('payments').add({
      // uid: user.uid,  // plus de uid — commande sans connexion obligatoire
      orderId:   orderRef.id,
      amount,
      status:    'pending',
      createdAt: new Date(),
    });

    const GW_URL = 'https://paymentgateway.lfdweb.com';
    const SITE   = process.env.SITE_URL || 'https://leadwase.com';
    const gRes   = await fetch(`${GW_URL}/api/gateway/generate-link`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.GATEWAY_API_KEY },
      body: JSON.stringify({
        amount, country: 'bj',
        description: `Carte LeadWase — ${firstName} ${lastName}`,
        origin: SITE, sendWebhook: true,
        metadata: {
          transactionId: payRef.id,
          orderId:       orderRef.id,
          // uid: user.uid,  // plus de uid
          origin:        SITE,
          sendWebhook:   true,
        },
      }),
    });

    // Log du statut HTTP brut pour détecter les erreurs 4xx/5xx de la gateway
    console.log('[gateway http status]', gRes.status);

    const gRaw = await gRes.text();
    console.log('[gateway response raw]', gRaw);

    let gData;
    try { gData = JSON.parse(gRaw); }
    catch { gData = { raw: gRaw }; }

    // Vérifier que la gateway a bien renvoyé pid et url avant tout update()
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
