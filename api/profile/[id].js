import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import PDFDocument from 'pdfkit';
import crypto from 'crypto';

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
  const { name, phone, email, object, source, website } = req.body || {};
  // Champ piège (honeypot) : invisible pour un humain, rempli par les robots → on ignore en silence.
  if (website) return res.json({ success: true });
  if (!name || (!phone && !email)) {
    return res.status(400).json({ success: false, error: 'Nom et (téléphone ou email) requis' });
  }
  const profileSnap = await db.collection('profiles').doc(leadwaseId).get();
  if (!profileSnap.exists) return res.status(404).json({ success: false, error: 'Profil introuvable' });
  const leadSource = source === 'nfc' ? 'nfc' : source === 'formulaire' ? 'formulaire' : 'lien_direct';
  const ref = await db.collection('prospects').add({
    ownerId:   leadwaseId,
    name:      String(name).trim().slice(0, 120),
    phone:     phone  ? String(phone).trim().slice(0, 40)  : '',
    email:     email  ? String(email).trim().slice(0, 120) : '',
    object:    object ? String(object).trim().slice(0, 300) : '',
    source:    leadSource,
    status:    'nouveau',
    notes:     '',
    createdAt: new Date(),
  });
  await logActivity(ref.id, 'system', leadSource === 'formulaire'
    ? 'Prospect capté via le formulaire de capture'
    : `Prospect capté via ${leadSource === 'nfc' ? 'carte NFC' : 'lien direct'} (bouton Échanger)`);
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
  const prospects = snap.docs.map(d => { const { unsubToken, ...rest } = d.data(); return { id: d.id, ...rest }; });
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

  const q = doc.data();
  const statusChanged = q.status !== status;
  const quoteUpdate = { status, updatedAt: new Date() };
  if (status === 'accepted' && statusChanged) quoteUpdate.acceptedAt = new Date();
  await ref.update(quoteUpdate);
  if (q.prospectId) {
    await logActivity(q.prospectId, 'note', `Devis ${q.quoteNumber} : statut → ${status}`);
    if (statusChanged && (status === 'sent' || status === 'accepted')) {
      const pRef = db.collection('prospects').doc(q.prospectId);
      const pDoc = await pRef.get();
      if (pDoc.exists && pDoc.data().ownerId === q.ownerId) {
        const p = pDoc.data();
        if (status === 'sent') {
          await autoAdvanceStatus(pRef, p, 'contacte', `devis ${q.quoteNumber} envoyé`);
        } else {
          const next = await autoAdvanceStatus(pRef, p, 'converti', `devis ${q.quoteNumber} accepté`);
          if (next && !p.dealValue) await pRef.update({ dealValue: q.total || 0 });
        }
      }
    }
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
  const { prospectId, status, notes, dealValue } = req.body || {};
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
  if (status !== undefined) {
    update.status = status;
    if (status === 'converti' && existing.status !== 'converti') update.convertedAt = new Date();
    if (status !== 'converti' && existing.status === 'converti') update.convertedAt = null;
  }
  if (notes  !== undefined) update.notes  = String(notes).slice(0, 1000);
  if (dealValue !== undefined) {
    const v = parseInt(dealValue, 10);
    update.dealValue = Number.isFinite(v) ? Math.min(Math.max(v, 0), 1e12) : 0;
  }
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
  await autoAdvanceStatus(db.collection('prospects').doc(prospectId), doc.data(), 'contacte', 'interaction enregistrée');
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
  await db.recursiveDelete(ref);
  res.json({ success: true });
}

// POST /api/profile/[id]?action=clear-prospects — authentifié, plan Business uniquement.
async function clearProspects(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  if (profile.plan !== 'business') throw new Error('Accès refusé');
  const snap = await db.collection('prospects').where('ownerId', '==', leadwaseId).get();
  for (let i = 0; i < snap.docs.length; i += 20) {
    await Promise.all(snap.docs.slice(i, i + 20).map(d => db.recursiveDelete(d.ref)));
  }
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
      id: doc.id, ...(({ unsubToken, ...rest }) => rest)(doc.data()),
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

// ═════════════════════════════════════════════════════════════════════════════
// CRM — helpers communs, documents, marketing (campagnes email), automatisations
// ═════════════════════════════════════════════════════════════════════════════

const SITE_URL = () => process.env.SITE_URL || 'https://leadwase.com';

function tsMillis(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v._seconds) return v._seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function allowedOwnersOf(profile, leadwaseId) {
  return [leadwaseId, ...(profile.isTeamOwner && Array.isArray(profile.teamMembers) ? profile.teamMembers : [])];
}

function requireCrm(profile) {
  if (profile.plan !== 'business' && !profile.isTeamOwner) throw new Error('Accès refusé');
}

const FIRESTORE_ID_RE = /^[A-Za-z0-9]{1,40}$/;

// Charge un prospect et vérifie que l'utilisateur connecté a le droit d'y toucher.
// Retourne { ref, data } ou { error: { code, message } } (404/400), ou lève 'Accès refusé'.
async function loadOwnedProspect(profile, leadwaseId, prospectId) {
  if (!prospectId || !FIRESTORE_ID_RE.test(String(prospectId))) {
    return { error: { code: 400, message: 'prospectId requis' } };
  }
  const ref = db.collection('prospects').doc(String(prospectId));
  const doc = await ref.get();
  if (!doc.exists) return { error: { code: 404, message: 'Prospect introuvable' } };
  if (!allowedOwnersOf(profile, leadwaseId).includes(doc.data().ownerId)) throw new Error('Accès refusé');
  return { ref, data: doc.data() };
}

function sendError(res, error) {
  return res.status(error.code).json({ success: false, error: error.message });
}

// Réponse d'erreur homogène pour les routes CRM récentes.
function fail(res, e) {
  const m = e?.message || 'Erreur';
  const code = m === 'Accès refusé' ? 403
    : (m === 'Non autorisé' || m.startsWith('Session invalide')) ? 401 : 500;
  if (code === 500) console.error('[crm]', e);
  return res.status(code).json({ success: false, error: m });
}

// ── Réglages CRM par propriétaire (collection crmSettings, jamais exposée publiquement) ──
const DEFAULT_CRM_SETTINGS = {
  autoStatus:       true,
  followUpEnabled:  false,
  followUpDays:     3,
  notifyOwner:      true,
  autoEmail:        false,
  autoEmailSubject: 'Suite à notre échange',
  autoEmailMessage: "Bonjour {{nom}},\n\nJe me permets de revenir vers vous suite à notre échange. Avez-vous eu le temps d'y réfléchir ? Je reste à votre disposition pour toute question.\n\nCordialement",
};

async function getCrmSettings(ownerId) {
  const d = await db.collection('crmSettings').doc(ownerId).get();
  return { ...DEFAULT_CRM_SETTINGS, ...(d.exists ? d.data() : {}) };
}

// Fait avancer automatiquement le statut d'un prospect suite à une action commerciale.
//  - 'contacte' : seulement si le prospect est encore 'nouveau'
//  - 'converti' : depuis n'importe quel statut sauf déjà 'converti'
// Retourne le nouveau statut, ou null si rien n'a changé.
async function autoAdvanceStatus(prospectRef, prospect, target, reason, settingsOverride) {
  try {
    const settings = settingsOverride || await getCrmSettings(prospect.ownerId);
    if (!settings.autoStatus) return null;
    const current = prospect.status || 'nouveau';
    let next = null;
    if (target === 'contacte' && current === 'nouveau') next = 'contacte';
    if (target === 'converti' && current !== 'converti') next = 'converti';
    if (!next) return null;
    const update = { status: next, updatedAt: new Date() };
    if (next === 'converti') update.convertedAt = new Date();
    await prospectRef.update(update);
    await logActivity(prospectRef.id, 'auto',
      `Statut changé automatiquement : ${STATUS_LABELS_FR[current] || 'Nouveau'} → ${STATUS_LABELS_FR[next]} (${reason})`);
    return next;
  } catch (e) {
    console.error('[autoAdvanceStatus]', e.message);
    return null;
  }
}

// ── Documents (contrat, devis signé…) joints à une fiche prospect ─────────────
// Stockage dans Firestore (aucun bucket à configurer) : le fichier est découpé en
// morceaux base64 de ~700 Ko dans prospects/{id}/documents/{docId}/chunks.
const DOC_MAX_BYTES       = 2.5 * 1024 * 1024;   // le plafond Vercel est de 4,5 Mo par requête (base64 = +33 %)
const DOC_CHUNK_CHARS     = 700000;              // < 1 Mio, limite d'un document Firestore
const DOC_MAX_PER_PROSPECT = 20;
const DOC_TYPES = {
  pdf:  'application/pdf',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  doc:  'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls:  'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt:  'text/plain',
  csv:  'text/csv',
};

function cleanFileName(name) {
  return String(name || '').replace(/[\\/\0\r\n]/g, '_').trim().slice(0, 120);
}

// POST ?action=upload-document { prospectId, name, dataBase64 }
async function uploadDocument(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  requireCrm(profile);
  const { prospectId, name, dataBase64 } = req.body || {};
  const owned = await loadOwnedProspect(profile, leadwaseId, prospectId);
  if (owned.error) return sendError(res, owned.error);

  const fileName = cleanFileName(name);
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (!fileName || !DOC_TYPES[ext]) {
    return res.status(400).json({ success: false, error: 'Format non accepté (PDF, images, Word, Excel, TXT, CSV)' });
  }
  if (typeof dataBase64 !== 'string' || !dataBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) {
    return res.status(400).json({ success: false, error: 'Fichier invalide' });
  }
  const size = Buffer.from(dataBase64, 'base64').length;
  if (!size) return res.status(400).json({ success: false, error: 'Fichier vide' });
  if (size > DOC_MAX_BYTES) {
    return res.status(400).json({ success: false, error: 'Fichier trop volumineux (2,5 Mo maximum)' });
  }

  const metaCol = owned.ref.collection('documents');
  const existing = await metaCol.limit(DOC_MAX_PER_PROSPECT).select().get();
  if (existing.size >= DOC_MAX_PER_PROSPECT) {
    return res.status(400).json({ success: false, error: `${DOC_MAX_PER_PROSPECT} documents maximum par prospect` });
  }

  const docRef = metaCol.doc();
  try {
    const batch = db.batch();
    for (let i = 0, n = 0; i < dataBase64.length; i += DOC_CHUNK_CHARS, n++) {
      batch.set(docRef.collection('chunks').doc(String(n).padStart(4, '0')),
        { i: n, data: dataBase64.slice(i, i + DOC_CHUNK_CHARS) });
    }
    await batch.commit();
    // La fiche n'est écrite qu'une fois tous les morceaux enregistrés : jamais de fichier incomplet listé.
    await docRef.set({ name: fileName, mime: DOC_TYPES[ext], size, uploadedBy: leadwaseId, createdAt: new Date() });
  } catch (e) {
    await db.recursiveDelete(docRef).catch(() => {});
    throw e;
  }
  await logActivity(owned.ref.id, 'document', `Document ajouté : ${fileName}`);
  res.json({ success: true, document: { id: docRef.id, name: fileName, mime: DOC_TYPES[ext], size } });
}

// GET ?action=list-documents&prospectId=xxx
async function listDocuments(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  requireCrm(profile);
  const owned = await loadOwnedProspect(profile, leadwaseId, req.query.prospectId);
  if (owned.error) return sendError(res, owned.error);
  const snap = await owned.ref.collection('documents').orderBy('createdAt', 'desc').limit(DOC_MAX_PER_PROSPECT).get();
  res.json({ success: true, documents: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
}

// GET ?action=download-document&prospectId=xxx&documentId=yyy
async function downloadDocument(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  requireCrm(profile);
  const owned = await loadOwnedProspect(profile, leadwaseId, req.query.prospectId);
  if (owned.error) return sendError(res, owned.error);
  const documentId = String(req.query.documentId || '');
  if (!FIRESTORE_ID_RE.test(documentId)) return res.status(400).json({ success: false, error: 'documentId requis' });

  const docRef = owned.ref.collection('documents').doc(documentId);
  const meta = await docRef.get();
  if (!meta.exists) return res.status(404).json({ success: false, error: 'Document introuvable' });
  const chunks = await docRef.collection('chunks').orderBy('i').get();
  const dataBase64 = chunks.docs.map(c => c.data().data).join('');
  res.json({ success: true, name: meta.data().name, mime: meta.data().mime, dataBase64 });
}

// POST ?action=delete-document { prospectId, documentId }
async function deleteDocument(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  requireCrm(profile);
  const { prospectId, documentId } = req.body || {};
  const owned = await loadOwnedProspect(profile, leadwaseId, prospectId);
  if (owned.error) return sendError(res, owned.error);
  if (!FIRESTORE_ID_RE.test(String(documentId || ''))) {
    return res.status(400).json({ success: false, error: 'documentId requis' });
  }
  const docRef = owned.ref.collection('documents').doc(String(documentId));
  const meta = await docRef.get();
  if (!meta.exists) return res.json({ success: true });
  const fileName = meta.data().name;
  await db.recursiveDelete(docRef);
  await logActivity(owned.ref.id, 'document', `Document supprimé : ${fileName}`);
  res.json({ success: true });
}

// ── Marketing : campagnes email vers une sélection de prospects ───────────────
const CAMPAIGN_MAX_PER_SEND = 50;
const CAMPAIGN_MAX_PER_DAY  = 200;   // reste sous le plafond d'envoi quotidien du forfait Brevo gratuit
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

async function ensureUnsubToken(ref, prospect) {
  if (prospect.unsubToken) return prospect.unsubToken;
  const token = crypto.randomBytes(16).toString('hex');
  await ref.update({ unsubToken: token });
  prospect.unsubToken = token;
  return token;
}

function unsubscribeUrl(ownerId, prospectId, token) {
  return `${SITE_URL()}/api/profile/${encodeURIComponent(ownerId)}?action=unsubscribe&p=${encodeURIComponent(prospectId)}&t=${token}`;
}

function personalize(text, prospect) {
  return String(text).replace(/\{\{\s*nom\s*\}\}/gi, () => prospect.name || '');
}

function senderLabel(profile) {
  const raw = profile.firstName
    ? `${profile.firstName}${profile.company ? ' — ' + profile.company : ''}`
    : (profile.company || 'LeadWase');
  return raw.replace(/["<>\r\n]/g, '').slice(0, 60) || 'LeadWase';
}

// POST ?action=send-campaign { prospectIds: [], subject, message }
async function sendCampaign(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  requireCrm(profile);

  const { prospectIds, subject, message } = req.body || {};
  const cleanSubject = String(subject || '').trim().slice(0, 150);
  const cleanMessage = String(message || '').trim().slice(0, 5000);
  if (!cleanSubject || !cleanMessage) {
    return res.status(400).json({ success: false, error: 'Objet et message requis' });
  }
  const ids = Array.isArray(prospectIds)
    ? [...new Set(prospectIds.map(String).filter(id => FIRESTORE_ID_RE.test(id)))] : [];
  if (!ids.length) return res.status(400).json({ success: false, error: 'Sélectionnez au moins un prospect' });
  if (ids.length > CAMPAIGN_MAX_PER_SEND) {
    return res.status(400).json({ success: false, error: `${CAMPAIGN_MAX_PER_SEND} destinataires maximum par envoi` });
  }
  if (!profile.email || !EMAIL_RE.test(profile.email)) {
    return res.status(400).json({ success: false, error: "Ajoutez une adresse email à votre profil : elle sert d'adresse de réponse pour vos prospects." });
  }

  const allowed = allowedOwnersOf(profile, leadwaseId);
  const docs = await db.getAll(...ids.map(id => db.collection('prospects').doc(id)));
  const skipped = { notFound: 0, noEmail: 0, unsubscribed: 0 };
  const targets = [];
  docs.forEach(d => {
    if (!d.exists || !allowed.includes(d.data().ownerId)) { skipped.notFound++; return; }
    const p = d.data();
    if (p.unsubscribed) { skipped.unsubscribed++; return; }
    if (!p.email || !EMAIL_RE.test(p.email)) { skipped.noEmail++; return; }
    targets.push({ ref: d.ref, id: d.id, p });
  });
  if (!targets.length) {
    return res.status(400).json({ success: false, error: 'Aucun destinataire valide (email manquant, désabonné ou introuvable)', skipped });
  }

  const settings = await getCrmSettings(leadwaseId);
  const today = new Date().toISOString().slice(0, 10);
  const usedToday = settings.campaignDay === today ? (settings.campaignCount || 0) : 0;
  if (usedToday + targets.length > CAMPAIGN_MAX_PER_DAY) {
    return res.status(400).json({ success: false,
      error: `Limite quotidienne de ${CAMPAIGN_MAX_PER_DAY} emails : il vous en reste ${Math.max(0, CAMPAIGN_MAX_PER_DAY - usedToday)} aujourd'hui.` });
  }

  const { sendCampaignMail } = await import('../../lib/brevo.js');
  const senderName = senderLabel(profile);
  let sent = 0, failed = 0, firstError = '';
  for (let i = 0; i < targets.length; i += 10) {
    const results = await Promise.allSettled(targets.slice(i, i + 10).map(async t => {
      const token = await ensureUnsubToken(t.ref, t.p);
      await sendCampaignMail({
        to: t.p.email, subject: cleanSubject, text: personalize(cleanMessage, t.p),
        senderName, replyTo: profile.email,
        unsubscribeUrl: unsubscribeUrl(t.p.ownerId, t.id, token),
      });
      // L'email est parti : les étapes suivantes ne doivent jamais le faire compter comme un échec.
      try {
        await logActivity(t.id, 'email', `Email envoyé : « ${cleanSubject} »`);
        await autoAdvanceStatus(t.ref, t.p, 'contacte', 'email envoyé', settings);
      } catch (e) { console.error('[sendCampaign] post-envoi', e.message); }
    }));
    results.forEach(r => {
      if (r.status === 'fulfilled') sent++;
      else { failed++; if (!firstError) firstError = r.reason?.message || 'Erreur inconnue'; }
    });
  }

  await db.collection('crmSettings').doc(leadwaseId).set({ campaignDay: today, campaignCount: usedToday + sent }, { merge: true });
  await db.collection('campaigns').add({
    ownerId: leadwaseId, subject: cleanSubject, message: cleanMessage,
    targeted: targets.length, sent, failed, skipped, createdAt: new Date(),
  });
  res.json({ success: true, sent, failed, skipped, error: failed ? firstError : undefined });
}

// GET ?action=list-campaigns
async function listCampaigns(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  requireCrm(profile);
  const snap = await db.collection('campaigns').where('ownerId', '==', leadwaseId).limit(100).get();
  const campaigns = snap.docs
    .map(d => { const c = d.data(); return { id: d.id, subject: c.subject, targeted: c.targeted, sent: c.sent, failed: c.failed, createdAt: c.createdAt }; })
    .sort((a, b) => tsMillis(b.createdAt) - tsMillis(a.createdAt))
    .slice(0, 30);
  res.json({ success: true, campaigns });
}

// GET ?action=unsubscribe&p=<prospectId>&t=<token> — public, lien présent dans chaque email.
async function unsubscribeProspect(req, res, leadwaseId) {
  const page = (title, body) => `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:Georgia,serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9f9f7"><div style="max-width:420px;padding:32px;text-align:center"><h2 style="color:#0a0a0a">${title}</h2><p style="color:#555;line-height:1.6">${body}</p></div></body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const p = String(req.query.p || ''), t = String(req.query.t || '');
  if (!FIRESTORE_ID_RE.test(p) || !/^[a-f0-9]{32}$/.test(t)) {
    return res.status(400).send(page('Lien invalide', "Ce lien de désabonnement n'est pas valide."));
  }
  const ref = db.collection('prospects').doc(p);
  const doc = await ref.get();
  const data = doc.exists ? doc.data() : null;
  const ok = data && data.ownerId === leadwaseId && data.unsubToken &&
    data.unsubToken.length === t.length &&
    crypto.timingSafeEqual(Buffer.from(data.unsubToken), Buffer.from(t));
  if (!ok) return res.status(400).send(page('Lien invalide', "Ce lien de désabonnement n'est pas valide."));

  if (!data.unsubscribed) {
    await ref.update({ unsubscribed: true, unsubscribedAt: new Date() });
    await logActivity(p, 'system', 'Le prospect s\u2019est désabonné des emails');
  }
  res.status(200).send(page('Désabonnement confirmé', 'Vous ne recevrez plus d\u2019emails de cet expéditeur. Merci.'));
}

// ── Automatisations ───────────────────────────────────────────────────────────
const FOLLOWUP_MAX_PER_OWNER = 50;

// GET ?action=get-automations
async function getAutomations(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  requireCrm(profile);
  const s = await getCrmSettings(leadwaseId);
  res.json({ success: true, settings: {
    autoStatus: !!s.autoStatus, followUpEnabled: !!s.followUpEnabled, followUpDays: s.followUpDays,
    notifyOwner: !!s.notifyOwner, autoEmail: !!s.autoEmail,
    autoEmailSubject: s.autoEmailSubject, autoEmailMessage: s.autoEmailMessage,
  }});
}

// POST ?action=save-automations { autoStatus, followUpEnabled, followUpDays, notifyOwner, autoEmail, autoEmailSubject, autoEmailMessage }
async function saveAutomations(req, res, leadwaseId) {
  const { profile } = await verifyOwner(req, leadwaseId);
  requireCrm(profile);
  const b = req.body || {};
  const days = parseInt(b.followUpDays, 10);
  const next = {
    autoStatus:       !!b.autoStatus,
    followUpEnabled:  !!b.followUpEnabled,
    followUpDays:     Math.min(60, Math.max(1, Number.isFinite(days) ? days : DEFAULT_CRM_SETTINGS.followUpDays)),
    notifyOwner:      !!b.notifyOwner,
    autoEmail:        !!b.autoEmail,
    autoEmailSubject: String(b.autoEmailSubject || '').trim().slice(0, 150) || DEFAULT_CRM_SETTINGS.autoEmailSubject,
    autoEmailMessage: String(b.autoEmailMessage || '').trim().slice(0, 3000) || DEFAULT_CRM_SETTINGS.autoEmailMessage,
    updatedAt:        new Date(),
  };
  if (next.autoEmail && (!profile.email || !EMAIL_RE.test(profile.email))) {
    return res.status(400).json({ success: false, error: "Ajoutez une adresse email à votre profil avant d'activer l'email de relance automatique (elle sert d'adresse de réponse)." });
  }
  await db.collection('crmSettings').doc(leadwaseId).set(next, { merge: true });
  res.json({ success: true });
}

// Relance les prospects restés « Nouveau » depuis plus de N jours pour un propriétaire :
// tâche de relance + (option) email au prospect + (option) email récapitulatif au propriétaire.
async function processOwnerAutomations(ownerId, settings) {
  const days = Math.min(60, Math.max(1, parseInt(settings.followUpDays, 10) || 3));
  const cutoff = Date.now() - days * 86400000;
  const snap = await db.collection('prospects')
    .where('ownerId', '==', ownerId).orderBy('createdAt', 'desc').limit(500).get();
  const due = snap.docs.filter(d => {
    const p = d.data();
    const created = tsMillis(p.createdAt);
    return (p.status || 'nouveau') === 'nouveau' && !p.autoFollowUpAt && created && created <= cutoff;
  }).slice(0, FOLLOWUP_MAX_PER_OWNER);
  if (!due.length) return { followUps: 0, emailsSent: 0 };

  const ownerDoc = await db.collection('profiles').doc(ownerId).get();
  const owner = ownerDoc.exists ? ownerDoc.data() : {};
  const today = new Date().toISOString().slice(0, 10);
  const canEmail = settings.autoEmail && owner.email && EMAIL_RE.test(owner.email);
  let sendCampaignMail = null;
  if (canEmail) ({ sendCampaignMail } = await import('../../lib/brevo.js'));

  const items = [];
  let emailsSent = 0;
  for (const d of due) {
    const p = d.data();
    const waitedDays = Math.max(days, Math.floor((Date.now() - tsMillis(p.createdAt)) / 86400000));
    await db.collection('tasks').add({
      ownerId, title: `Relancer ${p.name || 'ce prospect'}`.slice(0, 200), dueDate: today,
      prospectId: d.id, prospectName: p.name || '', done: false, auto: true, createdAt: new Date(),
    });
    await d.ref.update({ autoFollowUpAt: new Date() });
    await logActivity(d.id, 'auto', `Relance automatique : tâche créée (prospect resté « Nouveau » depuis ${waitedDays} jours)`);
    items.push({ name: p.name || '—', days: waitedDays });

    if (canEmail && p.email && EMAIL_RE.test(p.email) && !p.unsubscribed) {
      try {
        const token = await ensureUnsubToken(d.ref, p);
        await sendCampaignMail({
          to: p.email, subject: settings.autoEmailSubject, text: personalize(settings.autoEmailMessage, p),
          senderName: senderLabel(owner), replyTo: owner.email,
          unsubscribeUrl: unsubscribeUrl(ownerId, d.id, token),
        });
        emailsSent++;
        await logActivity(d.id, 'email', `Email de relance automatique envoyé : « ${settings.autoEmailSubject} »`);
        await autoAdvanceStatus(d.ref, p, 'contacte', 'relance automatique envoyée', settings);
      } catch (e) { console.error('[automations] email prospect', e.message); }
    }
  }

  if (settings.notifyOwner && owner.email && EMAIL_RE.test(owner.email)) {
    try {
      const { notifyOwnerFollowUps } = await import('../../lib/brevo.js');
      await notifyOwnerFollowUps({ ownerEmail: owner.email, ownerName: owner.firstName || '', items, emailsSent });
    } catch (e) { console.error('[automations] email propriétaire', e.message); }
  }
  return { followUps: items.length, emailsSent };
}

// GET (cron Vercel, en-tête Authorization: Bearer CRON_SECRET) ou POST (propriétaire connecté,
// bouton « Lancer maintenant ») ?action=run-automations
async function runAutomations(req, res, leadwaseId) {
  const secret = process.env.CRON_SECRET;
  const authHeader = String(req.headers.authorization || '');
  const expected = secret ? `Bearer ${secret}` : null;
  const isCron = expected && authHeader.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));

  if (isCron) {
    const snap = await db.collection('crmSettings').where('followUpEnabled', '==', true).get();
    let followUps = 0, emailsSent = 0, errors = 0;
    for (const d of snap.docs) {
      try {
        const r = await processOwnerAutomations(d.id, { ...DEFAULT_CRM_SETTINGS, ...d.data() });
        followUps += r.followUps; emailsSent += r.emailsSent;
      } catch (e) { errors++; console.error('[automations] propriétaire', d.id, e.message); }
    }
    return res.json({ success: true, owners: snap.size, followUps, emailsSent, errors });
  }

  const { profile } = await verifyOwner(req, leadwaseId);
  requireCrm(profile);
  const settings = await getCrmSettings(leadwaseId);
  if (!settings.followUpEnabled) {
    return res.status(400).json({ success: false, error: "Activez d'abord la relance automatique (et enregistrez) avant de la lancer." });
  }
  const r = await processOwnerAutomations(leadwaseId, settings);
  res.json({ success: true, ...r });
}

const CRM_ROUTES = {
  'POST:upload-document':   uploadDocument,
  'GET:list-documents':     listDocuments,
  'GET:download-document':  downloadDocument,
  'POST:delete-document':   deleteDocument,
  'POST:send-campaign':     sendCampaign,
  'GET:list-campaigns':     listCampaigns,
  'GET:get-automations':    getAutomations,
  'POST:save-automations':  saveAutomations,
  'GET:run-automations':    runAutomations,
  'POST:run-automations':   runAutomations,
};

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
    if (action === 'unsubscribe' && req.method === 'GET') {
      return unsubscribeProspect(req, res, leadwaseId).catch(e => {
        console.error('[unsubscribe]', e);
        res.status(500).send('Erreur, merci de réessayer.');
      });
    }
    const crmRoute = CRM_ROUTES[`${req.method}:${action}`];
    if (crmRoute) return crmRoute(req, res, leadwaseId).catch(e => fail(res, e));
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
