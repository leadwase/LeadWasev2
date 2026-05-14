const BREVO_API_KEY  = process.env.BREVO_API_KEY;
const ADMIN_EMAIL    = 'supportleadwase@gmail.com';
const SENDER         = { name: 'LeadWase', email: 'supportleadwase@gmail.com' };
const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

async function sendMail({ to, subject, html }) {
  const res = await fetch(BREVO_ENDPOINT, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key':      BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: SENDER,
      to:     [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });
  const data = await res.json();
  if (!res.ok) console.error('[brevo error]', JSON.stringify(data));
  else         console.log('[brevo sent]', subject, '→', to);
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Notif admin — nouvelle commande reçue (paiement complété)
// ─────────────────────────────────────────────────────────────────────────────
export async function notifyAdminNewOrder({ orderId, firstName, lastName, email, phone, amount, plan }) {
  return sendMail({
    to:      ADMIN_EMAIL,
    subject: `🛒 Nouvelle commande LeadWase — ${firstName} ${lastName}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:auto">
        <h2 style="color:#16a34a">Nouvelle commande reçue</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:8px;color:#555">Commande</td><td style="padding:8px;font-weight:bold">${orderId}</td></tr>
          <tr style="background:#f9f9f9"><td style="padding:8px;color:#555">Client</td><td style="padding:8px">${firstName} ${lastName}</td></tr>
          <tr><td style="padding:8px;color:#555">Email</td><td style="padding:8px">${email}</td></tr>
          <tr style="background:#f9f9f9"><td style="padding:8px;color:#555">Téléphone</td><td style="padding:8px">${phone}</td></tr>
          <tr><td style="padding:8px;color:#555">Plan</td><td style="padding:8px">${plan || 'Carte Classique'}</td></tr>
          <tr style="background:#f9f9f9"><td style="padding:8px;color:#555">Montant</td><td style="padding:8px;font-weight:bold;color:#16a34a">${amount} FCFA</td></tr>
        </table>
        <p style="margin-top:20px;font-size:13px;color:#888">Connectez-vous au dashboard pour générer les identifiants du client.</p>
      </div>
    `,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Notif client — paiement réussi (avant génération des identifiants)
// ─────────────────────────────────────────────────────────────────────────────
export async function notifyClientPaymentSuccess({ firstName, email, amount }) {
  return sendMail({
    to:      email,
    subject: `✅ Paiement confirmé — LeadWase`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:auto">
        <h2 style="color:#16a34a">Votre paiement a été reçu !</h2>
        <p>Bonjour <strong>${firstName}</strong>,</p>
        <p>Nous avons bien reçu votre paiement de <strong>${amount} FCFA</strong>.</p>
        <p>Votre carte LeadWase est en cours de préparation. Vous recevrez vos identifiants de connexion dans les prochaines 48h.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
        <p style="font-size:12px;color:#888">Pour toute question : <a href="mailto:supportleadwase@gmail.com">supportleadwase@gmail.com</a></p>
      </div>
    `,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Notif client — paiement échoué
// ─────────────────────────────────────────────────────────────────────────────
export async function notifyClientPaymentFailed({ firstName, email, amount }) {
  return sendMail({
    to:      email,
    subject: `❌ Paiement échoué — LeadWase`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:auto">
        <h2 style="color:#dc2626">Votre paiement n'a pas abouti</h2>
        <p>Bonjour <strong>${firstName}</strong>,</p>
        <p>Votre paiement de <strong>${amount} FCFA</strong> n'a pas pu être traité.</p>
        <p>Vous pouvez réessayer en passant une nouvelle commande :</p>
        <a href="https://leadwase.com/commander.html"
           style="display:inline-block;margin-top:12px;padding:12px 24px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">
          Réessayer ma commande
        </a>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
        <p style="font-size:12px;color:#888">Besoin d'aide ? <a href="mailto:supportleadwase@gmail.com">supportleadwase@gmail.com</a></p>
      </div>
    `,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Notif client — identifiants générés par l'admin
// ─────────────────────────────────────────────────────────────────────────────
export async function notifyClientCredentials({ firstName, email, leadwaseId, password }) {
  return sendMail({
    to:      email,
    subject: `🎉 Vos identifiants LeadWase — ${leadwaseId}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:auto">
        <h2 style="color:#16a34a">Votre carte LeadWase est prête !</h2>
        <p>Bonjour <strong>${firstName}</strong>,</p>
        <p>Voici vos identifiants de connexion à votre espace profil LeadWase :</p>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px;margin:20px 0">
          <p style="margin:0 0 8px"><strong>Identifiant :</strong> <span style="font-size:18px;color:#16a34a;letter-spacing:1px">${leadwaseId}</span></p>
          <p style="margin:0"><strong>Mot de passe :</strong> <span style="font-size:18px;color:#16a34a;letter-spacing:1px">${password}</span></p>
        </div>
        <a href="https://leadwase.com/connexion.html"
           style="display:inline-block;padding:12px 24px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">
          Me connecter à mon profil
        </a>
        <p style="margin-top:20px;font-size:13px;color:#888">⚠️ Conservez ces identifiants précieusement. Vous pouvez changer votre mot de passe depuis votre profil.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
        <p style="font-size:12px;color:#888">Support : <a href="mailto:supportleadwase@gmail.com">supportleadwase@gmail.com</a></p>
      </div>
    `,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Notif admin — paiement échoué (pour suivi)
// ─────────────────────────────────────────────────────────────────────────────
export async function notifyAdminPaymentFailed({ orderId, firstName, lastName, email, amount }) {
  return sendMail({
    to:      ADMIN_EMAIL,
    subject: `⚠️ Paiement échoué — ${firstName} ${lastName}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:auto">
        <h2 style="color:#dc2626">Paiement échoué</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:8px;color:#555">Commande</td><td style="padding:8px;font-weight:bold">${orderId}</td></tr>
          <tr style="background:#f9f9f9"><td style="padding:8px;color:#555">Client</td><td style="padding:8px">${firstName} ${lastName}</td></tr>
          <tr><td style="padding:8px;color:#555">Email</td><td style="padding:8px">${email}</td></tr>
          <tr style="background:#f9f9f9"><td style="padding:8px;color:#555">Montant</td><td style="padding:8px">${amount} FCFA</td></tr>
        </table>
      </div>
    `,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Notif admin — demande B2B reçue
// ─────────────────────────────────────────────────────────────────────────────
export async function notifyAdminB2BRequest({ orderId, company, name, email, phone, quantity, description }) {
  return sendMail({
    to:      ADMIN_EMAIL,
    subject: `📋 Nouvelle demande B2B — ${company}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:auto">
        <h2 style="color:#2563eb">Nouvelle demande B2B</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:8px;color:#555">Référence</td><td style="padding:8px;font-weight:bold;font-family:monospace">${orderId.slice(-6).toUpperCase()}</td></tr>
          <tr style="background:#f9f9f9"><td style="padding:8px;color:#555">Entreprise</td><td style="padding:8px;font-weight:bold">${company}</td></tr>
          <tr><td style="padding:8px;color:#555">Responsable</td><td style="padding:8px">${name}</td></tr>
          <tr style="background:#f9f9f9"><td style="padding:8px;color:#555">Email</td><td style="padding:8px"><a href="mailto:${email}">${email}</a></td></tr>
          <tr><td style="padding:8px;color:#555">Téléphone</td><td style="padding:8px">${phone}</td></tr>
          <tr style="background:#f9f9f9"><td style="padding:8px;color:#555">Quantité</td><td style="padding:8px">${quantity}</td></tr>
          <tr><td style="padding:8px;color:#555">Besoin</td><td style="padding:8px;font-style:italic">${description}</td></tr>
        </table>
        <p style="margin-top:20px;font-size:13px;color:#888">Répondez directement à <a href="mailto:${email}">${email}</a> avec votre devis.</p>
      </div>
    `,
  });
}
