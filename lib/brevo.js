const BREVO_API_KEY  = process.env.BREVO_API_KEY;
const ADMIN_EMAIL    = 'supportleadwase@gmail.com';
const SENDER         = { name: 'LeadWase', email: 'supportleadwase@gmail.com' };
const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

async function sendMail({ to, subject, html, attachments = [] }) {
  const body = {
    sender:      SENDER,
    to:          [{ email: to }],
    subject,
    htmlContent: html,
  };

  if (attachments.length > 0) {
    body.attachment = attachments; // [{ content: base64String, name: 'fichier.pdf' }]
  }

  const res = await fetch(BREVO_ENDPOINT, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key':      BREVO_API_KEY,
    },
    body: JSON.stringify(body),
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
        <p style="margin-top:20px;font-size:13px;color:#888">Connectez-vous au dashboard pour gérer la commande du client.</p>
      </div>
    `,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Notif client — paiement réussi
//    • Carte classique  → affiche loginEmail + password + lien connexion
//    • Abonnement       → password === null, on n'affiche pas le bloc identifiants
//    • Facture PDF      → jointe si invoicePdfBase64 est fourni
// ─────────────────────────────────────────────────────────────────────────────
export async function notifyClientPaymentSuccess({
  firstName,
  email,
  amount,
  loginEmail       = null,
  password         = null,
  leadwaseId       = null,
  invoicePdfBase64 = null,
}) {
  const isNewCard = !!password; // true = première carte, false = renouvellement/abonnement

  const credentialsBlock = isNewCard ? `
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px;margin:20px 0">
      <p style="margin:0 0 8px;font-size:14px;color:#555">Vos identifiants de connexion :</p>
      <p style="margin:0 0 8px"><strong>Login :</strong>
        <span style="font-size:16px;color:#16a34a;letter-spacing:0.5px">${loginEmail}</span>
      </p>
      <p style="margin:0"><strong>Mot de passe :</strong>
        <span style="font-size:16px;color:#16a34a;letter-spacing:0.5px">${password}</span>
      </p>
    </div>
    <a href="https://leadwase.com/connexion.html"
       style="display:inline-block;padding:12px 24px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">
      Me connecter à mon profil
    </a>
    <p style="margin-top:16px;font-size:12px;color:#888">
      ⚠️ Conservez ces identifiants précieusement. Vous pouvez changer votre mot de passe depuis votre profil.
    </p>
  ` : `
    <a href="https://leadwase.com/connexion.html"
       style="display:inline-block;padding:12px 24px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">
      Accéder à mon profil
    </a>
  `;

  const invoiceNote = invoicePdfBase64
    ? `<p style="margin-top:16px;font-size:13px;color:#555">📎 Votre facture est jointe à cet e-mail.</p>`
    : '';

  const attachments = invoicePdfBase64 ? [{
    content: invoicePdfBase64,
    name:    `facture-leadwase-${leadwaseId || 'recu'}.pdf`,
  }] : [];

  return sendMail({
    to:      email,
    subject: `✅ Paiement confirmé — LeadWase`,
    attachments,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:auto">
        <h2 style="color:#16a34a">Votre paiement a été reçu !</h2>
        <p>Bonjour <strong>${firstName}</strong>,</p>
        <p>Nous avons bien reçu votre paiement de <strong>${amount} FCFA</strong>.
           Merci pour votre confiance !</p>
        ${credentialsBlock}
        ${invoiceNote}
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="font-size:12px;color:#888">
          Pour toute question : <a href="mailto:supportleadwase@gmail.com">supportleadwase@gmail.com</a>
        </p>
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
        <p style="font-size:12px;color:#888">
          Besoin d'aide ? <a href="mailto:supportleadwase@gmail.com">supportleadwase@gmail.com</a>
        </p>
      </div>
    `,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Notif client — identifiants générés manuellement par l'admin
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
          <p style="margin:0 0 8px"><strong>Identifiant :</strong>
            <span style="font-size:18px;color:#16a34a;letter-spacing:1px">${leadwaseId}</span>
          </p>
          <p style="margin:0"><strong>Mot de passe :</strong>
            <span style="font-size:18px;color:#16a34a;letter-spacing:1px">${password}</span>
          </p>
        </div>
        <a href="https://leadwase.com/connexion.html"
           style="display:inline-block;padding:12px 24px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">
          Me connecter à mon profil
        </a>
        <p style="margin-top:20px;font-size:13px;color:#888">
          ⚠️ Conservez ces identifiants précieusement. Vous pouvez changer votre mot de passe depuis votre profil.
        </p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
        <p style="font-size:12px;color:#888">
          Support : <a href="mailto:supportleadwase@gmail.com">supportleadwase@gmail.com</a>
        </p>
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
// 7. Notif propriétaire — soumission de son formulaire de contact (profil public)
// ─────────────────────────────────────────────────────────────────────────────
export async function notifyOwnerContactForm({ ownerEmail, ownerName, leadwaseId, values }) {
  const rows = Object.entries(values || {}).map(([label, val]) => `
    <tr><td style="padding:8px;color:#555;vertical-align:top">${label}</td><td style="padding:8px;font-weight:bold">${val || '—'}</td></tr>
  `).join('');
  return sendMail({
    to:      ownerEmail,
    subject: `📨 Nouveau message via votre profil LeadWase`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:auto">
        <h2 style="color:#16a34a">Nouveau message reçu</h2>
        <p>Bonjour ${ownerName || ''}, quelqu'un vient de remplir le formulaire de contact de votre profil LeadWase (${leadwaseId}) :</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>
        <p style="margin-top:20px;font-size:13px;color:#888">Retrouvez également ce contact dans "Mes Prospects" sur votre tableau de bord.</p>
        <a href="https://leadwase.com/prospects.html"
           style="display:inline-block;margin-top:8px;padding:12px 24px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">
          Voir mes prospects
        </a>
      </div>
    `,
  });
}
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
        <p style="margin-top:20px;font-size:13px;color:#888">
          Répondez directement à <a href="mailto:${email}">${email}</a> avec votre devis.
        </p>
      </div>
    `,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Message admin → un ou plusieurs utilisateurs (page Messages du dashboard admin)
// ─────────────────────────────────────────────────────────────────────────────
export async function sendAdminMessage({ to, firstName, subject, message }) {
  return sendMail({
    to,
    subject,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:auto">
        <div style="text-align:center;margin-bottom:20px">
          <span style="font-size:20px;font-weight:bold">Lead<span style="color:#16a34a">Wase</span></span>
        </div>
        <p>Bonjour ${firstName || ''},</p>
        <div style="white-space:pre-line;line-height:1.7;color:#333">${message}</div>
        <p style="margin-top:24px;font-size:13px;color:#888">— L'équipe LeadWase</p>
      </div>
    `,
  });
}
