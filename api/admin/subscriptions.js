// api/admin/subscriptions.js — GET /api/admin/subscriptions (authentifié admin)
//                                GET /api/admin/subscriptions?action=check-expirations
//                                    (tâche cron externe, sécurisée par CRON_SECRET)
import { db, verifyAdmin, setCors } from '../../lib/firebaseAdmin.js';

// ── Tâche cron : rappels J-3 + rétrogradation des abonnements expirés ─────────
// À appeler une fois par jour depuis un service externe (cron-job.org) puisque
// le plan Vercel Hobby ne permet pas les cron jobs à fréquence libre.
async function checkExpirations(req, res) {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Secret cron invalide' });
  }

  const { notifySubscriptionExpiring, notifySubscriptionExpired } = await import('../../lib/brevo.js');

  const now       = new Date();
  const in3Days   = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const activeSnap = await db.collection('subscriptions').where('status', '==', 'active').get();

  let expired = 0, reminded = 0, errors = 0;

  for (const doc of activeSnap.docs) {
    const s = doc.data();
    const expiry = s.expiryDate?.toDate ? s.expiryDate.toDate() : (s.expiryDate ? new Date(s.expiryDate) : null);
    if (!expiry) continue;

    try {
      if (expiry <= now) {
        // ── Abonnement expiré : rétrograde le profil en Free ─────────────────
        await doc.ref.update({ status: 'expired', expiredAt: now });

        const profileQuery = await db.collection('profiles').where('firebaseUid', '==', s.uid).limit(1).get();
        if (!profileQuery.empty) {
          const profileDoc = profileQuery.docs[0];
          const p = profileDoc.data();
          await profileDoc.ref.update({ plan: 'free', updatedAt: now });
          if (p.email) {
            await notifySubscriptionExpired({ email: p.email, firstName: p.firstName, plan: s.plan });
          }
        }
        await db.collection('users').doc(s.uid).set({ plan: 'free' }, { merge: true });
        expired++;
      } else if (expiry <= in3Days && !s.reminderSentAt) {
        // ── Rappel J-3, envoyé une seule fois (marqué via reminderSentAt) ────
        const profileQuery = await db.collection('profiles').where('firebaseUid', '==', s.uid).limit(1).get();
        if (!profileQuery.empty) {
          const p = profileQuery.docs[0].data();
          if (p.email) {
            await notifySubscriptionExpiring({
              email: p.email, firstName: p.firstName, plan: s.plan,
              expiryDate: expiry.toLocaleDateString('fr-FR'),
            });
          }
        }
        await doc.ref.update({ reminderSentAt: now });
        reminded++;
      }
    } catch (e) {
      console.error('[checkExpirations] erreur sur', doc.id, e.message);
      errors++;
    }
  }

  res.json({ success: true, checked: activeSnap.size, expired, reminded, errors });
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.query.action === 'check-expirations') {
    return checkExpirations(req, res);
  }

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
