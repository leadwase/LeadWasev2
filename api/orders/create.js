import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { notifyAdminNewOrder, notifyAdminB2BRequest, notifyClientPaymentSuccess } from '../../lib/brevo.js';
import { getPrices } from '../../lib/getPrices.js';
import { limitOrReject } from '../../lib/rateLimit.js';

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
  // Endpoint public : limité en débit (anti-spam / anti-bourrage de la base et de la boîte admin).
  if (await limitOrReject(req, res, 'order-create', 10, 3600)) return;

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    // Toute donnée saisie est convertie en texte et bornée avant d'être stockée ou envoyée par email.
    const clean = (v, n) => String(v ?? '').trim().slice(0, n);
    const cardType    = clean(body.cardType, 20);
    const firstName   = clean(body.firstName, 80);
    const lastName    = clean(body.lastName, 80);
    const jobTitle    = clean(body.jobTitle, 120);
    const company     = clean(body.company, 150);
    const phone       = clean(body.phone, 40);
    const email       = clean(body.email, 120);
    const address     = clean(body.address, 300);
    const quantity    = clean(body.quantity, 60);
    const description = clean(body.description, 2000);
    const subPlan     = clean(body.subPlan, 20);
    const employees   = body.employees;

    // Validation des données requises
    if (!cardType || !firstName || !email) {
      return res.status(400).json({ 
        error: 'Champs requis manquants',
        required: ['cardType', 'firstName', 'email']
      });
    }
    if (!/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email)) {
      return res.status(400).json({ error: 'Adresse email invalide' });
    }

    // ── Commande B2B ────────────────────────────────
    if (cardType === 'b2b') {
      const cleanEmployees = Array.isArray(employees)
        ? employees
            .filter(e => e && (e.name || e.email || e.phone))
            .slice(0, 500)
            .map(e => ({
              name:  String(e.name  || '').trim().slice(0, 120),
              email: String(e.email || '').trim().slice(0, 120),
              phone: String(e.phone || '').trim().slice(0, 40),
            }))
        : [];

      const orderRef = await db.collection('orders').add({
        cardType:    'b2b',
        firstName,
        company,
        phone:       phone || '',
        email,
        quantity:    quantity || '',
        description: description || '',
        subPlan:     ['free', 'pro', 'business'].includes(subPlan) ? subPlan : 'free',
        employees:   cleanEmployees,
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
      return res.status(500).json({ error: 'Erreur lors de la récupération des prix' });
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
      return res.status(502).json({ error: 'Impossible de contacter la passerelle de paiement' });
    }

    const gRaw = await gRes.text();

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
      console.error('[gateway] réponse invalide', gRes.status);
      return res.status(502).json({ error: 'La passerelle de paiement a refusé la demande. Réessayez ou contactez le support.' });
    }

    await payRef.update({ pid: gData.pid, payUrl: gData.url });
    await orderRef.update({ paymentId: payRef.id, pid: gData.pid });
    
   // return res.json({ success: true, orderId: orderRef.id, payUrl: gData.url });
    return res.json({ success: true, orderId: orderRef.id, payUrl: gData.url });

  } catch (e) {
    // Jamais de données personnelles (req.body) dans les journaux, jamais de détail interne au client.
    console.error('❌ Erreur création commande :', e.message);
    return res.status(500).json({ error: 'Erreur serveur interne' });
  }
}
