// api/get-confirmation.js
// Gère deux routes :
//   GET /api/get-confirmation?orderId=...        → détails commande
//   GET /api/get-confirmation?subscriptionId=... → détails abonnement
//   GET /api/get-confirmation?checkCarte=1       → vérifie si l'utilisateur a une carte (Bearer token requis)
//   GET /api/get-confirmation?generateInvoice=1&orderId=...        → télécharge la facture PDF (Bearer token requis)
//   GET /api/get-confirmation?generateInvoice=1&subscriptionId=... → télécharge la facture PDF (Bearer token requis)

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';
import { getAuth }                       from 'firebase-admin/auth';
import PDFDocument                       from 'pdfkit';

if (!getApps().length) {
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  })});
}
const db = getFirestore();

// Convertit un Timestamp Firestore en ms (ou null)
function toMs(ts) {
  if (!ts) return null;
  if (ts._seconds)  return ts._seconds  * 1000;
  if (ts.seconds)   return ts.seconds   * 1000;
  if (ts.toMillis)  return ts.toMillis();
  return null;
}

/**
 * Génère une facture PDF en mémoire et retourne un Buffer.
 * @param {object} params
 * @returns {Promise<Buffer>}
 */
function generateInvoice({ invoiceNumber, date, firstName, lastName, email, phone, amount, plan, leadwaseId }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - 100; // marges de 50 de chaque côté
    const dateStr = new Date(date).toLocaleDateString('fr-FR', {
      day: '2-digit', month: 'long', year: 'numeric',
    });

    // ── En-tête ──────────────────────────────────────────────────────────────
    doc.fontSize(22).fillColor('#1a1a2e').font('Helvetica-Bold').text('LEADWASE', 50, 50);
    doc.fontSize(9).fillColor('#666').font('Helvetica').text('leadwase.com', 50, 76);

    doc.fontSize(22).fillColor('#1a1a2e').font('Helvetica-Bold')
       .text('FACTURE', 0, 50, { align: 'right' });
    doc.fontSize(9).fillColor('#666').font('Helvetica')
       .text(`N° ${invoiceNumber}`, 0, 76, { align: 'right' });
    doc.text(`Date : ${dateStr}`, 0, 90, { align: 'right' });

    // ── Ligne de séparation ──────────────────────────────────────────────────
    doc.moveTo(50, 115).lineTo(545, 115).strokeColor('#e0e0e0').lineWidth(1).stroke();

    // ── Bloc client ──────────────────────────────────────────────────────────
    doc.fontSize(9).fillColor('#999').font('Helvetica').text('FACTURÉ À', 50, 130);
    doc.fontSize(11).fillColor('#1a1a2e').font('Helvetica-Bold')
       .text(`${firstName} ${lastName}`, 50, 144);
    doc.fontSize(10).fillColor('#444').font('Helvetica').text(email, 50, 159);
    if (phone) doc.text(phone, 50, 173);
    if (leadwaseId) {
      doc.fontSize(9).fillColor('#999').text(`ID : ${leadwaseId}`, 50, phone ? 188 : 173);
    }

    // ── Tableau ──────────────────────────────────────────────────────────────
    const tableTop = 240;
    const colDesc  = 50;
    const colQty   = 350;
    const colPrix  = 420;
    const colTotal = 490;

    // En-tête tableau
    doc.rect(50, tableTop, pageWidth, 24).fill('#1a1a2e');
    doc.fontSize(9).fillColor('#fff').font('Helvetica-Bold');
    doc.text('DESCRIPTION',  colDesc  + 4, tableTop + 8);
    doc.text('QTÉ',          colQty,        tableTop + 8, { width: 60, align: 'center' });
    doc.text('P.U.',         colPrix,        tableTop + 8, { width: 60, align: 'right' });
    doc.text('TOTAL',        colTotal,       tableTop + 8, { width: 55, align: 'right' });

    // Ligne produit
    const rowY = tableTop + 24;
    doc.rect(50, rowY, pageWidth, 30).fill('#f7f7fb');
    doc.fontSize(10).fillColor('#1a1a2e').font('Helvetica-Bold')
       .text(plan, colDesc + 4, rowY + 9);
    doc.fontSize(9).fillColor('#555').font('Helvetica')
       .text('1', colQty, rowY + 11, { width: 60, align: 'center' });
    const amountStr = `${Number(amount).toLocaleString('fr-FR')} FCFA`;
    doc.text(amountStr, colPrix, rowY + 11, { width: 60, align: 'right' });
    doc.text(amountStr, colTotal, rowY + 11, { width: 55, align: 'right' });

    // ── Totaux ───────────────────────────────────────────────────────────────
    const totY = rowY + 50;
    doc.fontSize(9).fillColor('#999').font('Helvetica')
       .text('Sous-total :', 350, totY, { width: 130, align: 'right' });
    doc.text(amountStr, 490, totY, { width: 55, align: 'right' });

    doc.fontSize(9).fillColor('#999')
       .text('TVA (0%) :', 350, totY + 16, { width: 130, align: 'right' });
    doc.text('0 FCFA', 490, totY + 16, { width: 55, align: 'right' });

    doc.moveTo(350, totY + 36).lineTo(545, totY + 36).strokeColor('#ccc').lineWidth(0.5).stroke();

    doc.rect(350, totY + 42, 195, 26).fill('#1a1a2e');
    doc.fontSize(11).fillColor('#fff').font('Helvetica-Bold')
       .text('TOTAL', 354, totY + 50, { width: 125, align: 'right' });
    doc.text(amountStr, 490, totY + 50, { width: 55, align: 'right' });

    // ── Note de paiement ─────────────────────────────────────────────────────
    doc.fontSize(9).fillColor('#27ae60').font('Helvetica-Bold')
       .text('✓ Paiement reçu — Merci pour votre confiance !', 50, totY + 90, { align: 'center', width: pageWidth });

    // ── Pied de page ─────────────────────────────────────────────────────────
    doc.moveTo(50, 760).lineTo(545, 760).strokeColor('#e0e0e0').lineWidth(1).stroke();
    doc.fontSize(8).fillColor('#aaa').font('Helvetica')
       .text('Leadwase — leadwase.com', 50, 768, { align: 'center', width: pageWidth });

    doc.end();
  });
}

export default async function handler(req, res) {
  // ── CORS ────────────────────────────────────────────────────────────────
  const origin = process.env.SITE_URL || 'https://leadwase.com';
  res.setHeader('Access-Control-Allow-Origin',  origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).end();

  const { orderId, subscriptionId, checkCarte, generateInvoice: genInvoiceParam } = req.query;

  // ── CAS CHECK-CARTE ──────────────────────────────────────────────────────
  // GET /api/get-confirmation?checkCarte=1
  // Header : Authorization: Bearer <idToken>
  if (checkCarte) {
    try {
      const token = (req.headers.authorization || '').split('Bearer ')[1];
      if (!token) return res.status(401).json({ hasCarte: false, error: 'Non autorisé' });

      // Vérifier le token Firebase
      const decoded = await getAuth().verifyIdToken(token);

      // Trouver le profil via firebaseUid
      const profilesSnap = await db.collection('profiles')
        .where('firebaseUid', '==', decoded.uid)
        .limit(1)
        .get();

      if (profilesSnap.empty) {
        return res.json({ hasCarte: false });
      }

      // L'ID du document profil est le leadwaseId (ex: "lw-68518")
      const leadwaseId = profilesSnap.docs[0].id.toUpperCase(); // → "LW-68518"

      // Chercher une commande paid avec ce leadwaseId
      const ordersSnap = await db.collection('orders')
        .where('leadwaseId', '==', leadwaseId)
        .where('status',    '==', 'paid')
        .limit(1)
        .get();

      return res.json({ hasCarte: !ordersSnap.empty });

    } catch (e) {
      console.error('[get-confirmation] checkCarte:', e);
      return res.json({ hasCarte: false });
    }
  }

  // ── CAS GÉNÉRATION DE FACTURE PDF ────────────────────────────────────────
  // GET /api/get-confirmation?generateInvoice=1&orderId=...
  // GET /api/get-confirmation?generateInvoice=1&subscriptionId=...
  // Header : Authorization: Bearer <idToken>
  if (genInvoiceParam) {
    try {
      const token = (req.headers.authorization || '').split('Bearer ')[1];
      if (!token) return res.status(401).json({ error: 'Non autorisé' });

      // Vérifier le token Firebase
      await getAuth().verifyIdToken(token);

      let invoiceParams = null;

      if (orderId) {
        const snap = await db.collection('orders').doc(orderId).get();
        if (!snap.exists) return res.status(404).json({ error: 'Commande introuvable' });
        const order = snap.data();
        if (order.status !== 'paid') return res.status(403).json({ error: 'Commande non payée' });

        // Récupérer le montant depuis le payment lié si besoin
        let amount = order.amount;
        if (!amount) {
          const paySnap = await db.collection('payments')
            .where('orderId', '==', orderId)
            .where('status', '==', 'success')
            .limit(1).get();
          if (!paySnap.empty) amount = paySnap.docs[0].data().amount;
        }

        invoiceParams = {
          invoiceNumber: orderId,
          date:          toMs(order.createdAt) || new Date(),
          firstName:     order.firstName  || '',
          lastName:      order.lastName   || '',
          email:         order.email      || '',
          phone:         order.phone      || '',
          amount:        amount           || 0,
          plan:          'Carte Classique Leadwase',
          leadwaseId:    order.leadwaseId || '',
        };

      } else if (subscriptionId) {
        const snap = await db.collection('subscriptions').doc(subscriptionId).get();
        if (!snap.exists) return res.status(404).json({ error: 'Abonnement introuvable' });
        const sub = snap.data();
        if (sub.status !== 'active') return res.status(403).json({ error: 'Abonnement non actif' });

        // Récupérer les infos du profil
        let firstName = '', lastName = '', email = '', phone = '';
        const firebaseUid = sub.firebaseUid || sub.uid;
        if (firebaseUid) {
          const profileSnap = await db.collection('profiles')
            .where('firebaseUid', '==', firebaseUid)
            .limit(1).get();
          if (!profileSnap.empty) {
            const p = profileSnap.docs[0].data();
            firstName = p.firstName || '';
            lastName  = p.lastName  || '';
            email     = p.email     || '';
            phone     = p.phone     || '';
          }
        }

        invoiceParams = {
          invoiceNumber: subscriptionId,
          date:          toMs(sub.paidAt || sub.startDate) || new Date(),
          firstName,
          lastName,
          email,
          phone,
          amount:        sub.amount || 0,
          plan:          `Abonnement Leadwase ${sub.plan?.toUpperCase() || ''}`,
          leadwaseId:    sub.leadwaseId || '',
        };

      } else {
        return res.status(400).json({ error: 'orderId ou subscriptionId requis' });
      }

      const pdfBuffer = await generateInvoice(invoiceParams);
      const filename  = `facture-leadwase-${invoiceParams.invoiceNumber}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', pdfBuffer.length);
      return res.status(200).end(pdfBuffer);

    } catch (e) {
      console.error('[get-confirmation] generateInvoice:', e);
      return res.status(500).json({ error: 'Erreur génération facture' });
    }
  }

  if (!orderId && !subscriptionId) {
    return res.status(400).json({ error: 'orderId, subscriptionId ou checkCarte requis' });
  }

  // ── CAS ABONNEMENT ───────────────────────────────────────────────────────
  if (subscriptionId) {
    try {
      const snap = await db.collection('subscriptions').doc(subscriptionId).get();
      if (!snap.exists) return res.status(404).json({ error: 'Abonnement introuvable' });

      const sub = snap.data();
      return res.json({
        type: 'subscription',
        data: {
          plan:        sub.plan        || null,
          amount:      sub.amount      || null,
          status:      sub.status      || null,
          createdAt:   toMs(sub.createdAt),
          activatedAt: toMs(sub.startDate || sub.activatedAt),
          paidAt:      toMs(sub.paidAt),
        },
      });
    } catch (e) {
      console.error('[get-confirmation] abonnement:', e);
      return res.status(500).json({ error: 'Erreur serveur' });
    }
  }

  // ── CAS COMMANDE CARTE ───────────────────────────────────────────────────
  if (orderId) {
    try {
      const snap = await db.collection('orders').doc(orderId).get();
      if (!snap.exists) return res.status(404).json({ error: 'Commande introuvable' });

      const order = snap.data();

      // Credentials — uniquement si paiement confirmé (status === 'paid')
      let credentials = null;
      if (order.leadwaseId && order.status === 'paid') {
        try {
          const credSnap = await db.collection('credentials').doc(order.leadwaseId).get();
          if (credSnap.exists) {
            const c = credSnap.data();
            credentials = {
              leadwaseId:   c.leadwaseId   || c.loginEmail || null,
              passwordHash: c.passwordHash || null,
            };
          }
        } catch (e) {
          console.warn('[get-confirmation] credentials introuvables:', e);
        }
      }

      return res.json({
        type: 'order',
        data: {
          firstName:  order.firstName  || '',
          lastName:   order.lastName   || '',
          phone:      order.phone      || '',
          address:    order.address    || '',
          amount:     order.amount     || null,
          status:     order.status     || '',
          leadwaseId: order.leadwaseId || null,
          createdAt:  toMs(order.createdAt),
        },
        credentials,
      });
    } catch (e) {
      console.error('[get-confirmation] commande:', e);
      return res.status(500).json({ error: 'Erreur serveur' });
    }
  }
}
