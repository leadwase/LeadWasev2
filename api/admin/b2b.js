// api/admin/b2b.js — GET /api/admin/b2b
import { db, verifyAdmin, setCors } from '../../lib/firebaseAdmin.js';

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    await verifyAdmin(req);
    const snap = await db.collection('orders')
      .where('cardType', '==', 'b2b')
      .orderBy('createdAt', 'desc').limit(200).get();
    const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, orders });
  } catch (e) {
    res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message });
  }
}
