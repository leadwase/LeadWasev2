// api/admin/subscriptions.js — GET /api/admin/subscriptions
import { db, verifyAdmin, setCors } from '../../lib/firebaseAdmin.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    await verifyAdmin(req);
    const snap = await db.collection('subscriptions')
      .orderBy('createdAt', 'desc').limit(200).get();
    const subscriptions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, subscriptions });
  } catch (e) {
    res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message });
  }
}
