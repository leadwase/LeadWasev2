// api/admin/credentials.js — GET /api/admin/credentials
import { db, verifyAdmin, setCors } from '../../lib/firebaseAdmin.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    await verifyAdmin(req);
    const credentialsSnapshot = await db.collection('credentials').get();
    const credentials = [];

    for (const doc of credentialsSnapshot.docs) {
      const credData   = doc.data();
      const leadwaseId = credData.leadwaseId || doc.id;

      let profile = null;
      try {
        const profileDoc = await db.collection('profiles').doc(leadwaseId).get();
        if (profileDoc.exists) profile = profileDoc.data();
      } catch (e) {
        console.warn('Profil manquant pour', leadwaseId);
      }

      credentials.push({
        leadwaseId,
        login:      leadwaseId,
        password:   credData.passwordHash || credData.password || '—',
        email:      profile?.email || '—',
        clientName: profile
          ? `${profile.firstName || ''} ${profile.lastName || ''}`.trim()
          : '—',
        createdAt: credData.createdAt || null,
      });
    }

    res.status(200).json({ success: true, credentials });
  } catch (e) {
    res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message });
  }
}
