// api/admin/credentials.js — GET  /api/admin/credentials
//                             POST /api/admin/credentials?action=send-message  { recipients: 'all'|[leadwaseId,...], subject, message }
// Le POST est regroupé ici (plutôt qu'un fichier api/ séparé) pour rester sous
// la limite de 12 fonctions serverless du plan Vercel Hobby : cette route gère
// déjà l'annuaire complet des utilisateurs (profils + emails), nécessaire pour
// cibler les destinataires d'un message.
import { db, verifyAdmin, setCors } from '../../lib/firebaseAdmin.js';

async function listCredentials(req, res) {
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
      plan:      profile?.plan || 'free',
      createdAt: credData.createdAt || null,
    });
  }

  res.status(200).json({ success: true, credentials });
}

async function sendMessage(req, res) {
  const { recipients, subject, message } = req.body || {};
  if (!subject?.trim() || !message?.trim()) {
    return res.status(400).json({ success: false, error: 'Objet et message requis' });
  }
  if (!recipients || (Array.isArray(recipients) && !recipients.length)) {
    return res.status(400).json({ success: false, error: 'Aucun destinataire sélectionné' });
  }

  // Construit la liste { email, firstName } des destinataires ciblés.
  let targets = [];
  if (recipients === 'all') {
    const profilesSnap = await db.collection('profiles').get();
    targets = profilesSnap.docs
      .map(d => d.data())
      .filter(p => p.email)
      .map(p => ({ email: p.email, firstName: p.firstName || '' }));
  } else {
    const ids = Array.isArray(recipients) ? recipients.slice(0, 500) : [];
    const docs = await Promise.all(ids.map(id => db.collection('profiles').doc(id).get()));
    targets = docs
      .filter(d => d.exists && d.data().email)
      .map(d => ({ email: d.data().email, firstName: d.data().firstName || '' }));
  }

  if (!targets.length) {
    return res.status(400).json({ success: false, error: 'Aucun destinataire avec email valide' });
  }

  const { sendAdminMessage } = await import('../../lib/brevo.js');
  const results = await Promise.allSettled(
    targets.map(t => sendAdminMessage({ to: t.email, firstName: t.firstName, subject, message }))
  );
  const sent   = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.length - sent;

  res.json({ success: true, sent, failed, total: targets.length });
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    await verifyAdmin(req);
  } catch (e) {
    return res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message });
  }

  try {
    if (req.query.action === 'send-message' && req.method === 'POST') {
      return await sendMessage(req, res);
    }
    return await listCredentials(req, res);
  } catch (e) {
    console.error('[admin/credentials]', e);
    res.status(500).json({ success: false, error: e.message });
  }
}

