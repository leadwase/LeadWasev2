// GET /api/config                → configuration Firebase publique (inchangé)
// GET /api/config?action=prices  → prix actuels (carte, Pro, Business) saisis dans Admin → Paramètres.
//   Public, mis en cache 30 s côté CDN : toute modification faite dans l'admin apparaît sur le site
//   en moins d'une minute. Source unique : settings/prices (la même que celle utilisée au paiement).
export default async function handler(req, res) {
  if (req.query?.action === 'prices') {
    if (req.method !== 'GET') return res.status(405).end();
    try {
      await import('../../lib/firebaseAdmin.js');            // initialise firebase-admin
      const { getPrices } = await import('../../lib/getPrices.js');
      const prices = await getPrices();
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=30');
      return res.status(200).json({ success: true, prices });
    } catch (e) {
      console.error('[config prices]', e.message);
      return res.status(500).json({ success: false, error: 'Prix indisponibles' });
    }
  }
  res.status(200).json({
    apiKey:            process.env.FIREBASE_API_KEY,
    authDomain:        process.env.FIREBASE_AUTH_DOMAIN,
    projectId:         process.env.FIREBASE_PROJECT_ID,
    storageBucket:     process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId:             process.env.FIREBASE_APP_ID,
  });
}
