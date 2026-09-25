import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import PDFDocument from 'pdfkit';

if (!getApps().length) {
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  })});
}
const db = getFirestore();

// ── Prospects ("Mes Prospects" / bouton "Échanger" du profil public) ─────────
// Regroupées ici (plutôt que dans un fichier api/ séparé) pour rester sous la
// limite de 12 fonctions serverless du plan Vercel Hobby.

// Vérifie que le token envoyé correspond bien au propriétaire du profil `leadwaseId`.
// Plusieurs signaux sont acceptés (l'écriture de firebaseUid au premier login peut
// échouer silencieusement selon connexion.html) : firebaseUid, uid, email interne,
// et en dernier recours users/{uid}.leadwaseId.
async function verifyOwner(req, leadwaseId) {
  const token = (req.headers.authorization || '').split('Bearer ')[1];
  if (!token) throw new Error('Non autorisé');

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(token);
  } catch (e) {
    console.error('[verifyOwner] verifyIdToken a échoué:', e.message);
    throw new Error('Session invalide, merci de vous reconnecter');
  }

  const profileDoc = await db.collection('profiles').doc(leadwaseId).get();
  if (!profileDoc.exists) throw new Error('Accès refusé');
  const pd = profileDoc.data();

  const ownsByFirebaseUid = pd.firebaseUid && pd.firebaseUid === decoded.uid;
  const ownsByUid         = pd.uid && pd.uid === decoded.uid;
  const ownsByEmail       = decoded.email &&
    decoded.email.toLowerCase() === `${leadwaseId.toLowerCase()}@leadwase.internal`;

  let ownsByUsersDoc = false;
  if (!ownsByFirebaseUid && !ownsByUid && !ownsByEmail) {
    const uDoc = await db.collection('users').doc(decoded.uid).get();
    ownsByUsersDoc = uDoc.exists && uDoc.data()?.leadwaseId === leadwaseId;
  }

  if (!ownsByFirebaseUid && !ownsByUid && !ownsByEmail && !ownsByUsersDoc) {
    console.error(`[verifyOwner] Accès refusé pour uid=${decoded.uid} sur profil ${leadwaseId}`);
    throw new Error('Accès refusé');
  }

  // Répare le profil au passage si firebaseUid manquait (évite de retomber sur ce bug).
  if (!pd.firebaseUid) {
    await profileDoc.ref.set({ firebaseUid: decoded.uid }, { merge: true }).catch(() => {});
  }

  return { decoded, profile: pd };
}

// POST /api/profile/[id]?action=capture-lead — public, appelé depuis le bouton
// "Échanger" de la page profil publique. N'importe quel visiteur peut soumettre
// ses coordonnées ; aucune authentification requise (comme un formulaire de contact).
async function captureLead(req, res, leadwaseId) {
  const { name, phone, email, object, source } = req.body || {};
  if (!name || (!phone && !email)) {
    return res.status(400).json({ success: false, error: 'Nom et (téléphone ou email) requis' });
  }
  const ref = await db.collection('prospects').add({
    ownerId:   leadwaseId,
    name:      String(name).trim().slice(0, 120),
    phone:     phone  ? String(phone).trim().slice(0, 40)  : '',
    email:     email  ? String(email).trim().slice(0, 120) : '',
    object:    object ? String(object).trim().slice(0, 300) : '',
    source:    source === 'nfc' ? 'nfc' : 'lien_direct',
    status:    'nouveau',
    notes:     '',
    createdAt: new Date(),
  });
  await logActivity(ref.id, 'system', `Prospect capté via ${source === 'nfc' ? 'carte NFC' : 'lien direct'} (bouton Échanger)`);
  res.json({ success: true });
}

// POST /api/profile/[id]?action=submit-contact-form — public, formulaire de contact
// personnalisé du profil public. Enregistre un prospect ET notifie le propriétaire par email.
async function submitContactForm(req, res, leadwaseId) {
  const { values, source } = req.body || {};
  if (!values || typeof values !== 'object' || !Object.keys(values).length) {
    return res.status(400).json({ success: false, error: 'Formulaire vide' });
  }

  const profileDoc = await db.collection('profiles').doc(leadwaseId).get();
  if (!profileDoc.exists) return res.status(404).json({ success: false, error: 'Profil introuvable' });
  const p = profileDoc.data();

  // Tente de retrouver un nom/téléphone/email dans les champs soumis pour l'annuaire prospects.
  const entries = Object.entries(values);
  const findByKeyword = (words) => {
    const hit = entries.find(([label]) => words.some(w => label.toLowerCase().includes(w)));
    return hit ? String(hit[1]).trim().slice(0, 120) : '';
  };
  const name  = findByKeyword(['nom', 'name'])   || 'Visiteur formulaire';
  const phone = findByKeyword(['tel', 'phone']);
  const email = findByKeyword(['email', 'mail']);
  const object = entries.map(([label, val]) => `${label} : ${val}`).join(' — ').slice(0, 500);

  const ref = await db.collection('prospects').add({
    ownerId:   leadwaseId,
    name, phone, email, object,
    source:    source === 'nfc' ? 'nfc' : 'lien_direct',
    viaForm:   true,
    status:    'nouveau',
    notes:     '',
    createdAt: new Date(),
  });
  await logActivity(ref.id, 'system', 'Prospect capté via le formulaire de contact');

  if (p.email) {
    try {
      const { notifyOwnerContactForm } = await import('../../lib/brevo.js');
      await notifyOwnerContactForm({
        ownerEmail: p.email,
        ownerName:  p.firstName || '',
        leadwaseId,
        values,
      });
    } catch (e) {
      console.error('[submitContactForm] envoi email échoué:', e.message);
      // On ne bloque pas la réponse au visiteur si l'email échoue — le prospect est déjà enregistré.
    }
  }

  res.json({ success: true });
}

// GET /api/profile/[id]?action=prospects — authentifié (propriétaire, plan Business uniquement).
async function listProspects(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  if (profile.plan !== 'business') throw new Error('Accès refusé');
  const snap = await db.collection('prospects')
    .where('ownerId', '==', leadwaseId)
    .orderBy('createdAt', 'desc')
    .limit(500)
    .get();
  const prospects = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  res.json({ success: true, prospects });
}

const PROSPECT_STATUSES = ['nouveau', 'contacte', 'qualifie', 'converti', 'perdu'];

// POST /api/profile/[id]?action=update-prospect { prospectId, status?, notes? }
// Autorisé pour le propriétaire du prospect (plan Business) OU le chef d'équipe
// pour n'importe quel prospect capté par une carte de son équipe.
// POST /api/profile/[id]?action=create-task { title, dueDate?, prospectId? }
// ── Devis (objet CRM autonome, indépendant de l'achat d'une carte) ────────────

function generateQuotePDF({ quoteNumber, date, company, items, total, ownerName, ownerCompany }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    doc.on('error', reject);

    const pageWidth = doc.page.width - 100;
    const dateStr = new Date(date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });

    doc.fontSize(22).fillColor('#1a1a2e').font('Helvetica-Bold').text('LEADWASE', 50, 50);
    doc.fontSize(9).fillColor('#666').font('Helvetica').text(ownerCompany || 'leadwase.com', 50, 76);

    doc.fontSize(22).fillColor('#1a1a2e').font('Helvetica-Bold').text('DEVIS', 0, 50, { align: 'right' });
    doc.fontSize(9).fillColor('#666').font('Helvetica')
       .text(`N° ${quoteNumber}`, 0, 76, { align: 'right' })
       .text(`Date : ${dateStr}`, 0, 90, { align: 'right' });

    doc.moveTo(50, 115).lineTo(545, 115).strokeColor('#e0e0e0').lineWidth(1).stroke();

    doc.fontSize(9).fillColor('#999').font('Helvetica').text('DEVIS POUR', 50, 130);
    doc.fontSize(11).fillColor('#1a1a2e').font('Helvetica-Bold').text(company || '—', 50, 144);

    const tableTop = 190;
    doc.rect(50, tableTop, pageWidth, 24).fill('#1a1a2e');
    doc.fontSize(9).fillColor('#fff').font('Helvetica-Bold');
    doc.text('DESCRIPTION', 54, tableTop + 8);
    doc.text('QTÉ', 350, tableTop + 8, { width: 60, align: 'center' });
    doc.text('P.U.', 420, tableTop + 8, { width: 60, align: 'right' });
    doc.text('TOTAL', 490, tableTop + 8, { width: 55, align: 'right' });

    let y = tableTop + 24;
    items.forEach((it, i) => {
      const rowH = 28;
      if (i % 2 === 0) doc.rect(50, y, pageWidth, rowH).fill('#f7f7fb');
      const lineTotal = it.quantity * it.unitPrice;
      doc.fontSize(10).fillColor('#1a1a2e').font('Helvetica').text(it.description, 54, y + 9, { width: 280 });
      doc.fontSize(9).fillColor('#555').text(String(it.quantity), 350, y + 10, { width: 60, align: 'center' });
      doc.text(`${it.unitPrice.toLocaleString('fr-FR')}`, 420, y + 10, { width: 60, align: 'right' });
      doc.text(`${lineTotal.toLocaleString('fr-FR')}`, 490, y + 10, { width: 55, align: 'right' });
      y += rowH;
    });

    const totY = y + 26;
    doc.moveTo(350, totY).lineTo(545, totY).strokeColor('#ccc').lineWidth(0.5).stroke();
    doc.rect(350, totY + 6, 195, 26).fill('#1a1a2e');
    doc.fontSize(11).fillColor('#fff').font('Helvetica-Bold').text('TOTAL', 354, totY + 14, { width: 125, align: 'right' });
    doc.text(`${total.toLocaleString('fr-FR')} FCFA`, 490, totY + 14, { width: 55, align: 'right' });

    doc.fontSize(9).fillColor('#999').font('Helvetica')
       .text('Ce devis est valable 30 jours à compter de sa date d\u2019émission.', 50, totY + 60, { align: 'center', width: pageWidth });

    doc.moveTo(50, 760).lineTo(545, 760).strokeColor('#e0e0e0').lineWidth(1).stroke();
    doc.fontSize(8).fillColor('#aaa').font('Helvetica').text('Leadwase — leadwase.com', 50, 768, { align: 'center', width: pageWidth });

    doc.end();
  });
}

// POST /api/profile/[id]?action=create-quote { prospectId?, prospectName?, company?, items: [{description,quantity,unitPrice}] }
async function createQuote(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  if (profile.plan !== 'business' && !profile.isTeamOwner) throw new Error('Accès refusé');

  const { prospectId, prospectName, company, items } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ success: false, error: 'Au moins une ligne de devis est requise' });
  }
  const cleanItems = items.map(it => ({
    description: String(it.description || '').trim().slice(0, 200),
    quantity:    Math.max(1, parseInt(it.quantity, 10) || 1),
    unitPrice:   Math.max(0, parseInt(it.unitPrice, 10) || 0),
  })).filter(it => it.description);
  if (!cleanItems.length) return res.status(400).json({ success: false, error: 'Description de ligne requise' });

  const total = cleanItems.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
  const quoteNumber = 'DEV-' + Date.now().toString(36).toUpperCase();

  const ref = await db.collection('quotes').add({
    ownerId: leadwaseId, quoteNumber,
    prospectId: prospectId || null, prospectName: prospectName || '', company: company || prospectName || '',
    items: cleanItems, total, status: 'draft', createdAt: new Date(),
  });

  if (prospectId) await logActivity(prospectId, 'note', `Devis créé (${quoteNumber}) — ${total.toLocaleString('fr-FR')} FCFA`);
  res.json({ success: true, quoteId: ref.id, quoteNumber });
}

// GET /api/profile/[id]?action=list-quotes
async function listQuotes(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  if (profile.plan !== 'business' && !profile.isTeamOwner) throw new Error('Accès refusé');

  const ownerIds = [leadwaseId, ...(profile.isTeamOwner && Array.isArray(profile.teamMembers) ? profile.teamMembers : [])];
  const lists = await Promise.all(ownerIds.map(id =>
    db.collection('quotes').where('ownerId', '==', id).orderBy('createdAt', 'desc').limit(200).get()
  ));
  let quotes = [];
  lists.forEach(snap => snap.docs.forEach(d => quotes.push({ id: d.id, ...d.data() })));
  quotes.sort((a, b) => (b.createdAt?._seconds || 0) - (a.createdAt?._seconds || 0));
  res.json({ success: true, quotes: quotes.slice(0, 200) });
}

// GET /api/profile/[id]?action=quote-pdf&quoteId=xxx
async function getQuotePdf(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  const { quoteId } = req.query;
  if (!quoteId) return res.status(400).json({ success: false, error: 'quoteId requis' });

  const doc = await db.collection('quotes').doc(quoteId).get();
  if (!doc.exists) return res.status(404).json({ success: false, error: 'Devis introuvable' });
  const q = doc.data();

  const allowedOwners = [leadwaseId, ...(profile.isTeamOwner && Array.isArray(profile.teamMembers) ? profile.teamMembers : [])];
  if (!allowedOwners.includes(q.ownerId)) throw new Error('Accès refusé');

  const pdfBase64 = await generateQuotePDF({
    quoteNumber: q.quoteNumber, date: q.createdAt?._seconds ? new Date(q.createdAt._seconds * 1000) : new Date(),
    company: q.company, items: q.items, total: q.total,
    ownerCompany: profile.company,
  });
  res.json({ success: true, pdfBase64, filename: `${q.quoteNumber}.pdf` });
}

// POST /api/profile/[id]?action=update-quote-status { quoteId, status }
async function updateQuoteStatus(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  const { quoteId, status } = req.body || {};
  if (!['draft', 'sent', 'accepted', 'rejected'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Statut invalide' });
  }
  const ref = db.collection('quotes').doc(quoteId);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ success: false, error: 'Devis introuvable' });

  const allowedOwners = [leadwaseId, ...(profile.isTeamOwner && Array.isArray(profile.teamMembers) ? profile.teamMembers : [])];
  if (!allowedOwners.includes(doc.data().ownerId)) throw new Error('Accès refusé');

  await ref.update({ status, updatedAt: new Date() });
  if (doc.data().prospectId) {
    await logActivity(doc.data().prospectId, 'note', `Devis ${doc.data().quoteNumber} : statut → ${status}`);
  }
  res.json({ success: true });
}

// POST /api/profile/[id]?action=delete-quote { quoteId }
async function deleteQuote(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  const { quoteId } = req.body || {};
  const ref = db.collection('quotes').doc(quoteId);
  const doc = await ref.get();
  if (!doc.exists) return res.json({ success: true });

  const allowedOwners = [leadwaseId, ...(profile.isTeamOwner && Array.isArray(profile.teamMembers) ? profile.teamMembers : [])];
  if (!allowedOwners.includes(doc.data().ownerId)) throw new Error('Accès refusé');

  await ref.delete();
  res.json({ success: true });
}

async function createTask(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  if (profile.plan !== 'business' && !profile.isTeamOwner) throw new Error('Accès refusé');

  const { title, dueDate, prospectId, prospectName } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ success: false, error: 'Titre requis' });

  await db.collection('tasks').add({
    ownerId:      leadwaseId,
    title:        String(title).trim().slice(0, 200),
    dueDate:      dueDate || null,
    prospectId:   prospectId || null,
    prospectName: prospectName || '',
    done:         false,
    createdAt:    new Date(),
  });
  res.json({ success: true });
}

// GET /api/profile/[id]?action=list-tasks — tâches du compte, et de toute l'équipe si chef.
async function listTasks(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  if (profile.plan !== 'business' && !profile.isTeamOwner) throw new Error('Accès refusé');

  const ownerIds = [leadwaseId, ...(profile.isTeamOwner && Array.isArray(profile.teamMembers) ? profile.teamMembers : [])];
  const nameMap = {};
  if (profile.isTeamOwner) {
    const docs = await Promise.all(ownerIds.map(id => db.collection('profiles').doc(id).get()));
    docs.forEach(d => { if (d.exists) nameMap[d.id] = d.data().firstName || d.id; });
  }

  const lists = await Promise.all(ownerIds.map(id =>
    db.collection('tasks').where('ownerId', '==', id).orderBy('createdAt', 'desc').limit(300).get()
  ));
  let tasks = [];
  lists.forEach((snap, i) => {
    snap.docs.forEach(doc => tasks.push({ id: doc.id, ...doc.data(), ownerName: nameMap[ownerIds[i]] || '' }));
  });
  tasks.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const da = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
    const db_ = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
    return da - db_;
  });
  res.json({ success: true, tasks: tasks.slice(0, 300) });
}

// POST /api/profile/[id]?action=update-task { taskId, done?, title?, dueDate? }
async function updateTask(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  const { taskId, done, title, dueDate } = req.body || {};
  if (!taskId) return res.status(400).json({ success: false, error: 'taskId requis' });

  const ref = db.collection('tasks').doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ success: false, error: 'Tâche introuvable' });

  const allowedOwners = [leadwaseId, ...(profile.isTeamOwner && Array.isArray(profile.teamMembers) ? profile.teamMembers : [])];
  if (!allowedOwners.includes(doc.data().ownerId)) throw new Error('Accès refusé');

  const update = {};
  if (done !== undefined) update.done = !!done;
  if (title !== undefined) update.title = String(title).trim().slice(0, 200);
  if (dueDate !== undefined) update.dueDate = dueDate || null;
  await ref.update(update);
  res.json({ success: true });
}

// POST /api/profile/[id]?action=delete-task { taskId }
async function deleteTask(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  const { taskId } = req.body || {};
  if (!taskId) return res.status(400).json({ success: false, error: 'taskId requis' });

  const ref = db.collection('tasks').doc(taskId);
  const doc = await ref.get();
  if (!doc.exists) return res.json({ success: true });

  const allowedOwners = [leadwaseId, ...(profile.isTeamOwner && Array.isArray(profile.teamMembers) ? profile.teamMembers : [])];
  if (!allowedOwners.includes(doc.data().ownerId)) throw new Error('Accès refusé');

  await ref.delete();
  res.json({ success: true });
}

const STATUS_LABELS_FR = { nouveau: 'Nouveau', contacte: 'Contacté', qualifie: 'Qualifié', converti: 'Converti', perdu: 'Perdu' };

async function logActivity(prospectId, type, text) {
  try {
    await db.collection('prospects').doc(prospectId).collection('activity').add({
      type, text: String(text).slice(0, 500), createdAt: new Date(),
    });
  } catch (e) { console.error('[logActivity]', e.message); }
}

async function updateProspect(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  const { prospectId, status, notes } = req.body || {};
  if (!prospectId) return res.status(400).json({ success: false, error: 'prospectId requis' });
  if (status !== undefined && !PROSPECT_STATUSES.includes(status)) {
    return res.status(400).json({ success: false, error: 'Statut invalide' });
  }

  const ref = db.collection('prospects').doc(prospectId);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ success: false, error: 'Prospect introuvable' });
  const existing = doc.data();

  const allowedOwners = [leadwaseId, ...(profile.isTeamOwner && Array.isArray(profile.teamMembers) ? profile.teamMembers : [])];
  if (!allowedOwners.includes(existing.ownerId)) throw new Error('Accès refusé');
  if (profile.plan !== 'business' && !profile.isTeamOwner) throw new Error('Accès refusé');

  const update = { updatedAt: new Date() };
  if (status !== undefined) update.status = status;
  if (notes  !== undefined) update.notes  = String(notes).slice(0, 1000);
  await ref.update(update);

  if (status !== undefined && status !== existing.status) {
    await logActivity(prospectId, 'status', `Statut changé : ${STATUS_LABELS_FR[existing.status] || 'Nouveau'} → ${STATUS_LABELS_FR[status]}`);
  }
  if (notes !== undefined && notes !== existing.notes) {
    await logActivity(prospectId, 'note', notes ? `Note mise à jour : ${notes}` : 'Note supprimée');
  }

  res.json({ success: true });
}

// POST /api/profile/[id]?action=log-activity { prospectId, text }
// Journal manuel d'interaction (ex: "Appel effectué", "Email de suivi envoyé").
async function logManualActivity(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  if (profile.plan !== 'business' && !profile.isTeamOwner) throw new Error('Accès refusé');

  const { prospectId, text } = req.body || {};
  if (!prospectId || !text || !String(text).trim()) {
    return res.status(400).json({ success: false, error: 'prospectId et texte requis' });
  }
  const doc = await db.collection('prospects').doc(prospectId).get();
  if (!doc.exists) return res.status(404).json({ success: false, error: 'Prospect introuvable' });

  const allowedOwners = [leadwaseId, ...(profile.isTeamOwner && Array.isArray(profile.teamMembers) ? profile.teamMembers : [])];
  if (!allowedOwners.includes(doc.data().ownerId)) throw new Error('Accès refusé');

  await logActivity(prospectId, 'interaction', text);
  res.json({ success: true });
}

// GET /api/profile/[id]?action=prospect-activity&prospectId=xxx
async function getProspectActivity(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  const { prospectId } = req.query;
  if (!prospectId) return res.status(400).json({ success: false, error: 'prospectId requis' });

  const doc = await db.collection('prospects').doc(prospectId).get();
  if (!doc.exists) return res.status(404).json({ success: false, error: 'Prospect introuvable' });

  const allowedOwners = [leadwaseId, ...(profile.isTeamOwner && Array.isArray(profile.teamMembers) ? profile.teamMembers : [])];
  if (!allowedOwners.includes(doc.data().ownerId)) throw new Error('Accès refusé');

  const snap = await db.collection('prospects').doc(prospectId).collection('activity')
    .orderBy('createdAt', 'desc').limit(100).get();
  const activity = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  res.json({ success: true, activity, prospect: { name: doc.data().name, email: doc.data().email, phone: doc.data().phone, createdAt: doc.data().createdAt } });
}

// DELETE /api/profile/[id]?action=prospects&prospectId=xxx — authentifié, plan Business uniquement.
async function deleteProspect(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  if (profile.plan !== 'business') throw new Error('Accès refusé');
  const { prospectId } = req.query;
  if (!prospectId) return res.status(400).json({ success: false, error: 'prospectId requis' });
  const ref = db.collection('prospects').doc(prospectId);
  const doc = await ref.get();
  if (!doc.exists || doc.data().ownerId !== leadwaseId) {
    return res.status(404).json({ success: false, error: 'Prospect introuvable' });
  }
  await ref.delete();
  res.json({ success: true });
}

// POST /api/profile/[id]?action=clear-prospects — authentifié, plan Business uniquement.
async function clearProspects(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  if (profile.plan !== 'business') throw new Error('Accès refusé');
  const snap = await db.collection('prospects').where('ownerId', '==', leadwaseId).get();
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  res.json({ success: true, deleted: snap.size });
}

// Fonction pour transformer l'ID réel en code public
function getPublicCode(lwId) {
  if (!lwId) return 'LW-????';
  
  // Nettoyer l'ID (enlever 'LW-' si présent pour le hash)
  const cleanId = lwId.toString().toUpperCase().replace('LW-', '');
  
  // Générer un hash court à partir de l'ID nettoyé
  let hash = 0;
  for (let i = 0; i < cleanId.length; i++) {
    hash = ((hash << 5) - hash) + cleanId.charCodeAt(i);
    hash |= 0;
  }
  const positiveHash = Math.abs(hash).toString(36).substring(0, 6).toUpperCase();
  return `LW-${positiveHash}`;
}

// GET /api/profile/[id]?action=google-reviews — public. Récupère la note +
// les derniers avis Google via l'API Google Places (Place Details), avec un
// cache Firestore de 6h pour limiter le coût des appels API.
const REVIEWS_CACHE_MS = 6 * 60 * 60 * 1000;

async function getGoogleReviews(req, res, leadwaseId) {
  const profileDoc = await db.collection('profiles').doc(leadwaseId).get();
  if (!profileDoc.exists) return res.status(404).json({ success: false, error: 'Profil introuvable' });
  const p = profileDoc.data();

  if (!p.googlePlaceId) {
    return res.json({ success: true, configured: false });
  }

  const cache = p.reviewsCache;
  if (cache && cache.fetchedAt && (Date.now() - cache.fetchedAt) < REVIEWS_CACHE_MS) {
    return res.json({ success: true, configured: true, ...cache.data, cached: true });
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    // Pas de clé configurée côté serveur : on retourne le cache existant (même expiré) si dispo.
    if (cache?.data) return res.json({ success: true, configured: true, ...cache.data, cached: true, stale: true });
    return res.json({ success: false, configured: true, error: 'GOOGLE_PLACES_API_KEY non configurée côté serveur' });
  }

  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(p.googlePlaceId)}&fields=rating,user_ratings_total,reviews,url&language=fr&key=${apiKey}`;
  const r = await fetch(url);
  const d = await r.json();
  if (d.status !== 'OK') {
    console.error('[getGoogleReviews] Places API error:', d.status, d.error_message);
    if (cache?.data) return res.json({ success: true, configured: true, ...cache.data, cached: true, stale: true });
    return res.json({ success: false, configured: true, error: d.error_message || d.status });
  }

  const data = {
    rating:      d.result.rating || 0,
    totalRatings: d.result.user_ratings_total || 0,
    mapsUrl:     d.result.url || '',
    reviews: (d.result.reviews || []).slice(0, 5).map(rv => ({
      author: rv.author_name, rating: rv.rating, text: rv.text,
      relativeTime: rv.relative_time_description, profilePhoto: rv.profile_photo_url,
    })),
  };

  await profileDoc.ref.set({ reviewsCache: { data, fetchedAt: Date.now() } }, { merge: true });
  res.json({ success: true, configured: true, ...data });
}

function genPwd(n = 12) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const special = '@#!$%&*';
  const all = upper + lower + digits + special;
  const pwd = [
    upper[Math.floor(Math.random() * upper.length)],
    lower[Math.floor(Math.random() * lower.length)],
    digits[Math.floor(Math.random() * digits.length)],
    special[Math.floor(Math.random() * special.length)],
  ];
  for (let i = pwd.length; i < n; i++) pwd.push(all[Math.floor(Math.random() * all.length)]);
  for (let i = pwd.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pwd[i], pwd[j]] = [pwd[j], pwd[i]];
  }
  return pwd.join('');
}

// GET /api/profile/[id]?action=team-list — authentifié, réservé au chef d'équipe (isTeamOwner).
// GET /api/profile/[id]?action=team-prospects — CRM agrégé : tous les prospects
// captués par le chef ET par chacune des cartes de son équipe.
async function getTeamProspects(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  if (!profile.isTeamOwner) throw new Error('Accès refusé');

  const memberIds = [leadwaseId, ...(Array.isArray(profile.teamMembers) ? profile.teamMembers : [])];
  const [profileDocs, prospectLists] = await Promise.all([
    Promise.all(memberIds.map(id => db.collection('profiles').doc(id).get())),
    Promise.all(memberIds.map(id =>
      db.collection('prospects').where('ownerId', '==', id).orderBy('createdAt', 'desc').limit(200).get()
    )),
  ]);

  const nameMap = {};
  profileDocs.forEach(d => { if (d.exists) nameMap[d.id] = (d.data().firstName || d.id); });

  let prospects = [];
  prospectLists.forEach((snap, i) => {
    const ownerId = memberIds[i];
    snap.docs.forEach(doc => prospects.push({
      id: doc.id, ...doc.data(),
      cardOwnerId: ownerId, cardOwnerName: nameMap[ownerId] || ownerId,
    }));
  });
  prospects.sort((a, b) => {
    const ta = a.createdAt?._seconds || (a.createdAt ? new Date(a.createdAt).getTime() / 1000 : 0);
    const tb = b.createdAt?._seconds || (b.createdAt ? new Date(b.createdAt).getTime() / 1000 : 0);
    return tb - ta;
  });

  res.json({ success: true, prospects: prospects.slice(0, 500), teamSize: memberIds.length });
}

// GET /api/profile/[id]?action=team-analytics — statistiques agrégées de visite
// (30 derniers jours) pour le chef et chacune des cartes de son équipe.
async function getTeamAnalytics(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  if (!profile.isTeamOwner) throw new Error('Accès refusé');

  const memberIds = [leadwaseId, ...(Array.isArray(profile.teamMembers) ? profile.teamMembers : [])];
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [profileDocs, visitSnaps] = await Promise.all([
    Promise.all(memberIds.map(id => db.collection('profiles').doc(id).get())),
    Promise.all(memberIds.map(id =>
      db.collection('analytics').doc(id).collection('visits')
        .where('visitedAt', '>=', since).limit(1000).get().catch(() => null)
    )),
  ]);

  const nameMap = {};
  profileDocs.forEach(d => { if (d.exists) nameMap[d.id] = (d.data().firstName || d.id); });

  let totalVisits = 0, totalClicks = 0;
  const perMember = memberIds.map((id, i) => {
    const docs = visitSnaps[i]?.docs || [];
    const views  = docs.filter(d => d.data().type === 'profile_view').length;
    const clicks = docs.length - views;
    totalVisits += views;
    totalClicks += clicks;
    return { leadwaseId: id, name: nameMap[id] || id, views, clicks, total: docs.length };
  }).sort((a, b) => b.total - a.total);

  res.json({ success: true, totalVisits, totalClicks, teamSize: memberIds.length, perMember });
}

// POST /api/profile/[id]?action=buy-extra-card — le chef d'équipe achète une carte
// supplémentaire (au prix négocié à la commande B2B). Retourne un lien de paiement ;
// la carte n'est provisionnée qu'après paiement confirmé (webhook).
async function buyExtraCard(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  if (!profile.isTeamOwner) throw new Error('Accès refusé');

  const amount = parseInt(profile.pricePerCard, 10);
  if (!amount || amount < 1) {
    return res.status(400).json({ success: false, error: "Prix par carte non défini pour votre équipe. Contactez le support." });
  }

  const orderRef = await db.collection('orders').add({
    cardType: 'b2b_extra', orderContext: 'extra_team_card', parentChefId: leadwaseId,
    firstName: profile.firstName || '', company: profile.company || '', email: profile.email || '',
    amount, status: 'pending', createdAt: new Date(),
  });
  const payRef = await db.collection('payments').add({
    orderId: orderRef.id, amount, status: 'pending', createdAt: new Date(),
  });

  const GW_URL = 'https://paymentgateway.lfdweb.com';
  const SITE   = process.env.SITE_URL || 'https://leadwase.com';
  const gRes = await fetch(`${GW_URL}/api/gateway/generate-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.GATEWAY_API_KEY },
    body: JSON.stringify({
      amount, country: 'bj',
      description: `LeadWase — carte employé supplémentaire (${profile.company || leadwaseId})`,
      origin: SITE, sendWebhook: true,
      metadata: { transactionId: payRef.id, orderId: orderRef.id, origin: SITE, sendWebhook: true },
    }),
  });
  const gData = await gRes.json().catch(() => null);
  if (!gRes.ok || !gData?.pid || !gData?.url) {
    await orderRef.update({ status: 'gateway_error' });
    return res.status(502).json({ success: false, error: "Impossible de générer le lien de paiement" });
  }
  await payRef.update({ pid: gData.pid, payUrl: gData.url });
  await orderRef.update({ paymentId: payRef.id, pid: gData.pid });

  res.json({ success: true, payUrl: gData.url, amount });
}

async function listTeam(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  if (!profile.isTeamOwner) throw new Error('Accès refusé');

  const memberIds = Array.isArray(profile.teamMembers) ? profile.teamMembers : [];
  const members = [];
  for (const mid of memberIds) {
    const [pDoc, cDoc] = await Promise.all([
      db.collection('profiles').doc(mid).get(),
      db.collection('credentials').doc(mid).get(),
    ]);
    if (!pDoc.exists) continue;
    const p = pDoc.data();
    members.push({
      leadwaseId: mid,
      name: p.firstName || '', email: p.email || '', phone: p.phone || '',
      plan: p.plan || 'free',
      password: cDoc.exists ? (cDoc.data().passwordHash || '') : '',
      createdAt: p.createdAt || null,
    });
  }
  res.json({ success: true, members, company: profile.company || '' });
}

// POST /api/profile/[id]?action=team-update-member — { memberId, name, email, phone }
async function updateTeamMember(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  if (!profile.isTeamOwner) throw new Error('Accès refusé');

  const { memberId, name, email, phone } = req.body || {};
  if (!memberId || !(profile.teamMembers || []).includes(memberId)) {
    return res.status(400).json({ success: false, error: 'memberId invalide' });
  }
  await db.collection('profiles').doc(memberId).update({
    firstName: (name  || '').trim().slice(0, 120),
    email:     (email || '').trim().slice(0, 120),
    phone:     (phone || '').trim().slice(0, 40),
    updatedAt: new Date(),
  });
  res.json({ success: true });
}

// POST /api/profile/[id]?action=team-regenerate-password — { memberId }
async function regenerateTeamMemberPassword(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  if (!profile.isTeamOwner) throw new Error('Accès refusé');

  const { memberId } = req.body || {};
  if (!memberId || !(profile.teamMembers || []).includes(memberId)) {
    return res.status(400).json({ success: false, error: 'memberId invalide' });
  }
  const newPwd = genPwd();
  await db.collection('credentials').doc(memberId).set(
    { leadwaseId: memberId, passwordHash: newPwd, updatedAt: new Date() },
    { merge: true }
  );
  res.json({ success: true, password: newPwd });
}

export default async function handler(req, res) {
  try {
    const { id } = req.query;
    
    if (!id) {
      return res.status(400).json({ error: 'ID manquant' });
    }
    
    const leadwaseId = id.toString().toUpperCase();

    // ── Routage des actions "prospects" (CRM) ───────────────────────────────
    const action = req.query.action;
    if (action === 'capture-lead' && req.method === 'POST') {
      return captureLead(req, res, leadwaseId).catch(e =>
        res.status(500).json({ success: false, error: e.message }));
    }
    if (action === 'submit-contact-form' && req.method === 'POST') {
      return submitContactForm(req, res, leadwaseId).catch(e =>
        res.status(500).json({ success: false, error: e.message }));
    }
    if (action === 'prospects' && req.method === 'GET') {
      return listProspects(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'prospects' && req.method === 'DELETE') {
      return deleteProspect(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'clear-prospects' && req.method === 'POST') {
      return clearProspects(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'update-prospect' && req.method === 'POST') {
      return updateProspect(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'log-activity' && req.method === 'POST') {
      return logManualActivity(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'prospect-activity' && req.method === 'GET') {
      return getProspectActivity(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'create-task' && req.method === 'POST') {
      return createTask(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'list-tasks' && req.method === 'GET') {
      return listTasks(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'update-task' && req.method === 'POST') {
      return updateTask(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'delete-task' && req.method === 'POST') {
      return deleteTask(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'create-quote' && req.method === 'POST') {
      return createQuote(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'list-quotes' && req.method === 'GET') {
      return listQuotes(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'quote-pdf' && req.method === 'GET') {
      return getQuotePdf(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'update-quote-status' && req.method === 'POST') {
      return updateQuoteStatus(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'delete-quote' && req.method === 'POST') {
      return deleteQuote(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'google-reviews' && req.method === 'GET') {
      return getGoogleReviews(req, res, leadwaseId).catch(e =>
        res.status(500).json({ success: false, error: e.message }));
    }
    if (action === 'team-list' && req.method === 'GET') {
      return listTeam(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'buy-extra-card' && req.method === 'POST') {
      return buyExtraCard(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'team-prospects' && req.method === 'GET') {
      return getTeamProspects(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'team-analytics' && req.method === 'GET') {
      return getTeamAnalytics(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'team-update-member' && req.method === 'POST') {
      return updateTeamMember(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }
    if (action === 'team-regenerate-password' && req.method === 'POST') {
      return regenerateTeamMemberPassword(req, res, leadwaseId).catch(e =>
        res.status(e.message === 'Accès refusé' ? 403 : 401).json({ success: false, error: e.message }));
    }

    console.log(`🔍 Recherche du profil: ${leadwaseId}`);
    
    // 1. Chercher le profil par son ID de document
    let profileDoc = await db.collection('profiles').doc(leadwaseId).get();
    let profileData = null;
    let actualDocId = leadwaseId;
    
    // 2. Si non trouvé, chercher par le champ leadwaseId
    if (!profileDoc.exists) {
      console.log(`⚠️ Document ${leadwaseId} non trouvé, recherche par champ leadwaseId...`);
      const querySnapshot = await db.collection('profiles')
        .where('leadwaseId', '==', leadwaseId)
        .limit(1)
        .get();
      
      if (!querySnapshot.empty) {
        profileDoc = querySnapshot.docs[0];
        actualDocId = profileDoc.id;
        console.log(`✅ Profil trouvé par leadwaseId: ${actualDocId}`);
      }
    }
    
    // 3. Si non trouvé, chercher par loginEmail ou email
    if (!profileDoc.exists) {
      console.log(`⚠️ Recherche par email...`);
      const emailQuery = await db.collection('profiles')
        .where('loginEmail', '==', `${leadwaseId.toLowerCase()}@leadwase.internal`)
        .limit(1)
        .get();
      
      if (!emailQuery.empty) {
        profileDoc = emailQuery.docs[0];
        actualDocId = profileDoc.id;
        console.log(`✅ Profil trouvé par loginEmail: ${actualDocId}`);
      }
    }
    
    if (!profileDoc.exists) {
      console.log(`❌ Profil non trouvé pour l'ID: ${leadwaseId}`);
      return res.status(404).json({ error: 'Profil introuvable' });
    }
    
    profileData = profileDoc.data();
    console.log(`✅ Profil chargé: ${actualDocId}, plan: ${profileData.plan || 'free'}`);
    
    // Récupérer l'abonnement actif si l'utilisateur a un firebaseUid
    let subscription = null;
    if (profileData.firebaseUid) {
      console.log(`🔍 Recherche d'abonnement pour firebaseUid: ${profileData.firebaseUid}`);
      
      const subQuery = await db.collection('subscriptions')
        .where('uid', '==', profileData.firebaseUid)
        .where('status', '==', 'active')
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get();
      
      if (!subQuery.empty) {
        const subDoc = subQuery.docs[0];
        const subData = subDoc.data();
        subscription = {
          id: subDoc.id,
          plan: subData.plan,
          status: subData.status,
          startDate: subData.startDate,
          expiryDate: subData.expiryDate,
          amount: subData.amount
        };
        console.log(`✅ Abonnement actif trouvé: ${subData.plan}`);
        
        // Si l'abonnement est actif mais le profil est encore "free", mettre à jour
        if (profileData.plan !== subData.plan && subData.plan !== 'free') {
          console.log(`⚠️ Mise à jour du plan: ${profileData.plan} → ${subData.plan}`);
          await profileDoc.ref.update({ 
            plan: subData.plan,
            updatedAt: new Date()
          });
          profileData.plan = subData.plan;
        }
      } else {
        console.log(`ℹ️ Aucun abonnement actif trouvé pour cet utilisateur`);
      }
    } else {
      console.log(`ℹ️ Pas de firebaseUid associé au profil`);
    }
    
    // Exclure les champs sensibles
    const { uid, firebaseUid, ...publicProfile } = profileData;
    
    // Ajouter le code public
    const publicCode = getPublicCode(actualDocId);
    
    // Ajouter les infos d'abonnement si disponibles
    const response = {
      success: true,
      profile: publicProfile,
      publicCode: publicCode,
      plan: profileData.plan || 'free'
    };
    
    if (subscription) {
      response.subscription = subscription;
    }
    
    res.json(response);
    
  } catch (e) { 
    console.error('❌ Erreur API profil:', e);
    res.status(500).json({ error: e.message }); 
  }
}
