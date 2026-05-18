// api/admin.js - Routeur unique pour TOUTES les routes admin
// Routes disponibles :
//   GET  ?route=orders
//   GET  ?route=payments
//   GET  ?route=subscriptions
//   GET  ?route=credentials
//   GET  ?route=stats
//   GET  ?route=b2b
//   GET  ?route=settings-prices
//   POST ?route=settings-prices
//   POST ?route=deliver
//   POST ?route=generate-credentials

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { notifyClientCredentials } from '../brevo.js';

// ✅ INITIALISATION UNIQUE
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

// ═══════════════════════════════════════════════════════════════
// FONCTIONS UTILITAIRES
// ═══════════════════════════════════════════════════════════════

function genId() {
  return 'LW-' + Math.floor(10000 + Math.random() * 90000);
}

function genPwd(n = 10) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#!';
  return Array.from({ length: n }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

// Prix par défaut
const DEFAULT_PRICES = { classic: 25000, pro: 3500, business: 9900 };

// ═══════════════════════════════════════════════════════════════
// FONCTIONS D'AUTHENTIFICATION
// ═══════════════════════════════════════════════════════════════

// Vérification admin stricte (avec rôle)
async function verifyAdmin(req) {
  const token = (req.headers.authorization || '').split('Bearer ')[1];
  if (!token) throw new Error('Non autorisé');
  const decoded = await getAuth().verifyIdToken(token);
  const u = await db.collection('users').doc(decoded.uid).get();
  if (u.data()?.role !== 'admin') throw new Error('Accès refusé');
  return decoded;
}

// Vérification simple (juste token valide)
async function verifyToken(req) {
  const token = (req.headers.authorization || '').split('Bearer ')[1];
  if (!token) throw new Error('Non autorisé');
  return getAuth().verifyIdToken(token);
}

// ═══════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const route = req.query.route || '';

  try {
    // ═══════════════════════════════════════════════════════════
    // GET orders
    // ═══════════════════════════════════════════════════════════
    if (route === 'orders' && req.method === 'GET') {
      await verifyAdmin(req);
      const snap = await db.collection('orders').orderBy('createdAt', 'desc').limit(200).get();
      const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return res.json({ success: true, orders });
    }

    // ═══════════════════════════════════════════════════════════
    // GET payments
    // ═══════════════════════════════════════════════════════════
    if (route === 'payments' && req.method === 'GET') {
      await verifyToken(req);
      const snap = await db.collection('payments')
        .orderBy('createdAt', 'desc')
        .limit(200)
        .get();
      const payments = snap.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
      }));
      return res.json({ success: true, payments });
    }

    // ═══════════════════════════════════════════════════════════
    // GET subscriptions
    // ═══════════════════════════════════════════════════════════
    if (route === 'subscriptions' && req.method === 'GET') {
      await verifyToken(req);
      const snap = await db.collection('subscriptions')
        .orderBy('createdAt', 'desc')
        .limit(200)
        .get();
      const subscriptions = snap.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
      }));
      return res.json({ success: true, subscriptions });
    }

    // ═══════════════════════════════════════════════════════════
    // GET credentials
    // ═══════════════════════════════════════════════════════════
    if (route === 'credentials' && req.method === 'GET') {
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

      const credentialsSnapshot = await db.collection('credentials').get();
      const credentials = [];

      for (const doc of credentialsSnapshot.docs) {
        const credData = doc.data();
        const leadwaseId = credData.leadwaseId || doc.id;

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
    }

    // ═══════════════════════════════════════════════════════════
    // GET b2b
    // ═══════════════════════════════════════════════════════════
    if (route === 'b2b' && req.method === 'GET') {
      await verifyAdmin(req);
      const snap = await db.collection('orders')
        .where('cardType', '==', 'b2b')
        .orderBy('createdAt', 'desc')
        .limit(200)
        .get();
      const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return res.json({ success: true, orders });
    }

    // ═══════════════════════════════════════════════════════════
    // GET stats - VERSION CORRIGÉE (utilise payments pour revenus)
    // ═══════════════════════════════════════════════════════════
    if (route === 'stats' && req.method === 'GET') {
      await verifyAdmin(req);
      
      const [orders, payments, subs] = await Promise.all([
        db.collection('orders').get(),
        db.collection('payments').where('status', '==', 'success').get(),
        db.collection('subscriptions').where('status', '==', 'active').get(),
      ]);
      
      const pending = orders.docs.filter(d => ['pending', 'paid'].includes(d.data().status)).length;
      const revenue = payments.docs.reduce((a, d) => a + (d.data().amount || 0), 0);
      
      return res.json({
        success: true,
        stats: {
          totalOrders: orders.size,
          totalRevenue: revenue,
          activeSubscriptions: subs.size,
          pendingOrders: pending
        }
      });
    }

    // ═══════════════════════════════════════════════════════════
    // GET settings-prices
    // ═══════════════════════════════════════════════════════════
    if (route === 'settings-prices' && req.method === 'GET') {
      await verifyToken(req);
      const ref = db.collection('settings').doc('prices');
      const snap = await ref.get();
      const prices = snap.exists ? snap.data() : DEFAULT_PRICES;
      return res.json({ success: true, prices });
    }

    // ═══════════════════════════════════════════════════════════
    // POST settings-prices
    // ═══════════════════════════════════════════════════════════
    if (route === 'settings-prices' && req.method === 'POST') {
      await verifyToken(req);
      const { prices } = req.body;
      if (!prices || typeof prices !== 'object') {
        return res.status(400).json({ success: false, error: 'Corps invalide : { prices: { classic, pro, business } }' });
      }
      const classic = parseInt(prices.classic) || 0;
      const pro = parseInt(prices.pro) || 0;
      const business = parseInt(prices.business) || 0;
      if (classic <= 0 || pro <= 0 || business <= 0) {
        return res.status(400).json({ success: false, error: 'Tous les prix doivent être > 0' });
      }
      const ref = db.collection('settings').doc('prices');
      await ref.set({ classic, pro, business, updatedAt: new Date() }, { merge: true });
      return res.json({ success: true, prices: { classic, pro, business } });
    }

    // ═══════════════════════════════════════════════════════════
    // POST deliver (marquer commande livrée)
    // ═══════════════════════════════════════════════════════════
    if (route === 'deliver' && req.method === 'POST') {
      await verifyAdmin(req);
      const { orderId } = req.body;
      if (!orderId) {
        return res.status(400).json({ success: false, error: 'orderId requis' });
      }
      await db.collection('orders').doc(orderId).update({
        status: 'delivered',
        deliveredAt: new Date()
      });
      return res.json({ success: true });
    }

    // ═══════════════════════════════════════════════════════════
    // POST generate-credentials (génération automatique après paiement)
    // ═══════════════════════════════════════════════════════════
    if (route === 'generate-credentials' && req.method === 'POST') {
      await verifyAdmin(req);
      const { orderId } = req.body;
      
      const order = await db.collection('orders').doc(orderId).get();
      if (!order.exists) {
        return res.status(404).json({ error: 'Commande introuvable' });
      }
      
      const d = order.data();
      
      // Identifiants déjà générés
      if (d.leadwaseId) {
        return res.json({ success: true, leadwaseId: d.leadwaseId, alreadyCreated: true });
      }
      
      let lwId = genId();
      const ex = await db.collection('profiles').where('leadwaseId', '==', lwId).get();
      if (!ex.empty) lwId = genId();
      
      const pwd = genPwd();
      
      // Création du profil
      await db.collection('profiles').doc(lwId).set({
        leadwaseId: lwId,
        firstName: d.firstName,
        lastName: d.lastName,
        jobTitle: d.jobTitle,
        company: d.company,
        phone: d.phone,
        email: d.email,
        plan: 'free',
        createdAt: new Date(),
      });
      
      // Création des credentials
      await db.collection('credentials').doc(lwId).set({
        leadwaseId: lwId,
        passwordHash: pwd,
        createdAt: new Date(),
      });
      
      // Mise à jour de la commande
      await order.ref.update({ status: 'delivered', leadwaseId: lwId });
      
      // Envoi des identifiants par email
      await notifyClientCredentials({
        firstName: d.firstName,
        email: d.email,
        leadwaseId: lwId,
        password: pwd,
      });
      
      return res.json({ success: true, leadwaseId: lwId, password: pwd });
    }

    // Route non trouvée
    return res.status(404).json({ success: false, error: `Route inconnue : ${route}` });

  } catch (e) {
    console.error(`[admin?route=${route}]`, e.message);
    const status = e.message === 'Accès refusé' || e.message === 'Non autorisé' ? 403 : 500;
    return res.status(status).json({ success: false, error: e.message });
  }
}
