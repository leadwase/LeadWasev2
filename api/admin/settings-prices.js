// api/admin/settings-prices.js — GET/POST /api/admin/settings-prices
import { db, verifyAdmin, setCors } from '../../lib/firebaseAdmin.js';

const DEFAULT_PRICES = { classic: 25000, pro: 3500, business: 9900 };

async function getPrices() {
  try {
    const snap = await db.collection('settings').doc('prices').get();
    if (snap.exists) {
      const d = snap.data();
      return {
        classic:  d.classic  || DEFAULT_PRICES.classic,
        pro:      d.pro      || DEFAULT_PRICES.pro,
        business: d.business || DEFAULT_PRICES.business,
      };
    }
  } catch (e) {
    console.warn('[getPrices] fallback:', e.message);
  }
  return DEFAULT_PRICES;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    await verifyAdmin(req);

    if (req.method === 'GET') {
      const prices = await getPrices();
      return res.json({ success: true, prices });
    }

    if (req.method === 'POST') {
      const { prices } = req.body;
      if (!prices || typeof prices !== 'object') {
        return res.status(400).json({ success: false, error: 'Corps invalide' });
      }
      const classic  = parseInt(prices.classic)  || 0;
      const pro      = parseInt(prices.pro)      || 0;
      const business = parseInt(prices.business) || 0;
      if (classic <= 0 || pro <= 0 || business <= 0) {
        return res.status(400).json({ success: false, error: 'Tous les prix doivent être > 0' });
      }
      await db.collection('settings').doc('prices').set(
        { classic, pro, business, updatedAt: new Date() },
        { merge: true }
      );
      return res.json({ success: true, prices: { classic, pro, business } });
    }

    res.status(405).end();
  } catch (e) {
    res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message });
  }
}
