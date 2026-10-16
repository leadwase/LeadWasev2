// api/admin/settings-prices.js — GET/POST /api/admin/settings-prices
import { db, verifyAdmin, setCors } from '../../lib/firebaseAdmin.js';

import { getPrices } from '../../lib/getPrices.js';

export default async function handler(req, res) {
  setCors(res, req);
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
      const current  = await getPrices();
      const MAX = 100000000;
      const num = (v, fallback) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : fallback; };
      const classic     = num(prices.classic, 0);
      const pro         = num(prices.pro, 0);
      const business    = num(prices.business, 0);
      // Tarifs B2B (annuel par carte) : facultatifs dans la requête, on conserve la valeur actuelle sinon.
      const b2bPro      = num(prices.b2bPro, current.b2bPro);
      const b2bBusiness = num(prices.b2bBusiness, current.b2bBusiness);
      const all = [classic, pro, business, b2bPro, b2bBusiness];
      if (all.some(n => n <= 0)) {
        return res.status(400).json({ success: false, error: 'Tous les prix doivent être > 0' });
      }
      if (all.some(n => n > MAX)) {
        return res.status(400).json({ success: false, error: 'Prix trop élevé' });
      }
      await db.collection('settings').doc('prices').set(
        { classic, pro, business, b2bPro, b2bBusiness, updatedAt: new Date() },
        { merge: true }
      );
      return res.json({ success: true, prices: { classic, pro, business, b2bPro, b2bBusiness } });
    }

    res.status(405).end();
  } catch (e) {
    res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message === 'Accès refusé' ? 'Accès refusé' : 'Non autorisé' });
  }
}
