import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { notifyAdminNewOrder, notifyAdminB2BRequest, notifyClientPaymentSuccess } from '../brevo.js';
import { getPrices } from '../../lib/getPrices.js';

if (!getApps().length) {
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  })});
}
const db = getFirestore();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  
  try {
    const { cardType, firstName, lastName, jobTitle, company, phone, email, address, quantity, description } = req.body;

    // Validation des données requises
    if (!cardType || !firstName || !email) {
      return res.status(400).json({ 
        error: 'Champs requis manquants',
        required: ['cardType', 'firstName', 'email']
      });
    }

    // ── Commande B2B ────────────────────────────────
    if (cardType === 'b2b') {
      const orderRef = await db.collection('orders').add({
        cardType:    'b2b',
        firstName,
        company,
        phone:       phone || '',
        email,
        quantity:    quantity || '',
        description: description || '',
        status:      'b2b_pending',
        amount:      null,
        createdAt:   new Date(),
      });

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

    // ── Commande Classique ──────────────────────────
    let prices;
    try {
      prices = await getPrices();
    } catch (priceError) {
      console.error('Erreur getPrices:', priceError);
      return res.status(500).json({ 
        error: 'Erreur lors de la récupération des prix',
        detail: priceError.message 
      });
    }

    const amount = prices.classic;
    
    if (!amount) {
      return res.status(500).json({ error: 'Prix non défini' });
    }

    const orderRef = await db.collection('orders').add({
      cardType, firstName, lastName, jobTitle, company, phone, email, address,
      amount,
      status:    'pending',
      createdAt: new Date(),
    });

    const payRef = await db.collection('payments').add({
      orderId:   orderRef.id,
      amount,
      status:    'pending',
      createdAt: new Date(),
    });

    const GW_URL = 'https://paymentgateway.lfdweb.com';
    const SITE   = process.env.SITE_URL || 'https://leadwase.com';
    
    let gRes;
    try {
      gRes = await fetch(`${GW_URL}/api/gateway/generate-link`, {
        method:  'POST',
        headers: { 
          'Content-Type': 'application/json', 
          'x-api-key': process.env.GATEWAY_API_KEY 
        },
        body: JSON.stringify({
          amount, 
          country: 'bj',
          description: `Carte LeadWase — ${firstName} ${lastName}`,
          origin: SITE, 
          sendWebhook: true,
          metadata: {
            transactionId: payRef.id,
            orderId:       orderRef.id,
            origin:        SITE,
            sendWebhook:   true,
          },
        }),
      });
    } catch (fetchError) {
      console.error('Erreur fetch gateway:', fetchError);
      await orderRef.update({ 
        status: 'gateway_error', 
        gatewayResponse: fetchError.message 
      });
      return res.status(502).json({ 
        error: 'Impossible de contacter la passerelle de paiement',
        detail: fetchError.message 
      });
    }

    console.log('[gateway http status]', gRes.status);

    const gRaw = await gRes.text();
    console.log('[gateway response raw]', gRaw);

    let gData;
    try { 
      gData = JSON.parse(gRaw); 
    } catch { 
      gData = { raw: gRaw }; 
    }

    if (!gRes.ok || !gData.pid || !gData.url) {
      await orderRef.update({ 
        status: 'gateway_error', 
        gatewayResponse: gRaw.slice(0, 500) 
      });
      return res.status(502).json({
        error: `Gateway ${gRes.status} — ${gData.message || gData.error || 'réponse invalide'}`,
        detail: gData,
      });
    }

    await payRef.update({ pid: gData.pid, payUrl: gData.url });
    await orderRef.update({ paymentId: payRef.id, pid: gData.pid });
    
   // return res.json({ success: true, orderId: orderRef.id, payUrl: gData.url });
    return res.json({ success: true, orderId: orderRef.id, payUrl: gData.url });

  } catch (e) {
    // Log complet pour le débogage
    console.error('❌ Erreur complète:', {
      message: e.message,
      stack: e.stack,
      body: req.body
    });
    
    return res.status(500).json({ 
      error: 'Erreur serveur interne',
      message: e.message 
    });
  }
}
