// lib/rateLimit.js
// Limitation de débit par IP + clé (Firestore, collection rateLimits).
// Protège les endpoints publics contre le spam, le bourrage de base et la force brute.
// - Les IP ne sont jamais stockées en clair (empreinte SHA-256 salée).
// - Fail-open : si Firestore est indisponible, on laisse passer (jamais de blocage des vrais clients).
// - Chaque document porte `expireAt` : activez une politique TTL Firestore sur ce champ pour le purge auto.
import crypto from 'crypto';
import { getFirestore } from 'firebase-admin/firestore';

export function clientIp(req) {
  const xf = req.headers?.['x-forwarded-for'];
  const raw = (Array.isArray(xf) ? xf[0] : xf) || req.headers?.['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
  return String(raw).split(',')[0].trim().slice(0, 64) || 'unknown';
}

// Retourne { ok: true } ou { ok: false, retryAfter } (secondes).
export async function rateLimit(req, key, max, windowSec) {
  try {
    const db = getFirestore();
    const salt = process.env.RATE_LIMIT_SALT || 'leadwase-rl';
    const id = crypto.createHash('sha256').update(`${salt}|${key}|${clientIp(req)}`).digest('hex').slice(0, 40);
    const ref = db.collection('rateLimits').doc(id);
    const now = Date.now();
    const snap = await ref.get();
    const d = snap.exists ? snap.data() : null;
    if (!d || now - d.start >= windowSec * 1000) {
      await ref.set({ start: now, count: 1, expireAt: new Date(now + windowSec * 1000 * 2) });
      return { ok: true };
    }
    if (d.count >= max) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((d.start + windowSec * 1000 - now) / 1000)) };
    }
    await ref.update({ count: d.count + 1 });
    return { ok: true };
  } catch (e) {
    console.error('[rateLimit] ignoré :', e.message);
    return { ok: true };
  }
}

// Répond 429 si la limite est dépassée. Retourne true quand la requête doit être stoppée.
export async function limitOrReject(req, res, key, max, windowSec) {
  const r = await rateLimit(req, key, max, windowSec);
  if (r.ok) return false;
  res.setHeader?.('Retry-After', String(r.retryAfter));
  res.status(429).json({ success: false, error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
  return true;
}
