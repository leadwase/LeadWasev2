import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp }       from 'firebase-admin/firestore';
import { getAuth }                        from 'firebase-admin/auth';
import PDFDocument                        from 'pdfkit';
import {
  notifyAdminNewOrder,
  notifyClientPaymentSuccess,
  notifyClientPaymentFailed,
  notifyAdminPaymentFailed,
} from '../../lib/brevo.js';

if (!getApps().length) {
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  })});
}
const db = getFirestore();
const auth = getAuth();

function genId() { return 'LW-' + Math.floor(10000 + Math.random() * 90000); }
function genPwd(n = 24) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: n }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

/**
 * Génère une facture PDF en mémoire et retourne un Buffer base64.
 * @param {object} params
 * @returns {Promise<string>} base64 du PDF
 */
function generateInvoice({ invoiceNumber, date, firstName, lastName, email, phone, amount, plan, leadwaseId }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
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
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { event, transaction } = req.body;
    const raw = (transaction?.status || event || '').toLowerCase();
    const ok  = ['successful','success','completed','paid','payment.completed'].includes(raw);
    const ko  = ['failed','failure','cancelled','rejected','payment.failed'].includes(raw);
    if (!ok && !ko) return res.json({ received: true, status: 'ignored' });

    // ── Retrouver le document payment ─────────────────────────────────────────
    let payDoc = null;
    const txId = transaction?.metadata?.transactionId;
    if (txId) {
      const d = await db.collection('payments').doc(txId).get();
      if (d.exists) payDoc = d;
    }
    if (!payDoc) {
      const ref = transaction?.reference || transaction?.id;
      if (ref) {
        const s = await db.collection('payments').where('pid','==',ref).limit(1).get();
        if (!s.empty) payDoc = s.docs[0];
      }
    }
    if (!payDoc && transaction?.amount) {
      const s = await db.collection('payments')
        .where('status','==','pending')
        .where('amount','==',transaction.amount)
        .orderBy('createdAt','desc').limit(1).get();
      if (!s.empty) payDoc = s.docs[0];
    }
    if (!payDoc) return res.json({ received: true });

    const pay = payDoc.data();
    if (pay.status === 'success') return res.json({ received: true });

    const status = ok ? 'success' : 'failed';
    await payDoc.ref.update({
      status,
      gatewayRef:       transaction?.reference,
      webhookVerified:  true,
      updatedAt:        new Date(),
    });

    // ── CARTE CLASSIQUE (achat carte physique) ────────────────────────────────
    if (ok && pay.orderId) {
      const ord   = await db.collection('orders').doc(pay.orderId).get();
      const oData = ord.data();

      let lwId = genId();
      const ex = await db.collection('profiles').where('leadwaseId','==',lwId).get();
      if (!ex.empty) lwId = genId();
      
      const pwd = genPwd();
      const cleanLwId = lwId.toLowerCase().replace('lw-', '');
      const loginEmail = `lw-${cleanLwId}@leadwase.internal`;
      const displayName = `${oData.firstName || ''} ${oData.lastName || ''}`.trim();

      let firebaseUid = null;
      try {
        const userRecord = await auth.createUser({
          email: loginEmail,
          password: pwd,
          displayName: displayName,
          emailVerified: true,
        });
        firebaseUid = userRecord.uid;
        console.log(`✅ Utilisateur Firebase créé: ${firebaseUid} pour ${loginEmail}`);
      } catch (authError) {
        console.error('❌ Erreur création utilisateur Firebase:', authError);
      }

      await ord.ref.update({ status: 'paid', leadwaseId: lwId, paidAt: new Date() });

      const profileData = {
        leadwaseId: lwId,
        firstName:  oData.firstName,
        lastName:   oData.lastName,
        jobTitle:   oData.jobTitle,
        company:    oData.company,
        phone:      oData.phone,
        email:      oData.email,
        loginEmail: loginEmail,
        plan:       'free',
        createdAt:  new Date(),
      };
      
      if (firebaseUid) {
        profileData.firebaseUid = firebaseUid;
      }

      await db.collection('profiles').doc(lwId).set(profileData);
      await db.collection('credentials').doc(lwId).set({
        leadwaseId:   lwId,
        loginEmail:   loginEmail,
        passwordHash: pwd,
        createdAt:    new Date(),
      });

      // Génération de la facture PDF
      let invoicePdfBase64 = null;
      try {
        invoicePdfBase64 = await generateInvoice({
          invoiceNumber: pay.orderId,
          date:          new Date(),
          firstName:     oData.firstName,
          lastName:      oData.lastName,
          email:         oData.email,
          phone:         oData.phone,
          amount:        pay.amount,
          plan:          'Carte Classique Leadwase',
          leadwaseId:    lwId,
        });
        console.log(`✅ Facture PDF générée pour ${lwId}`);
      } catch (pdfError) {
        console.error('❌ Erreur génération facture PDF:', pdfError);
      }

      await Promise.allSettled([
        notifyAdminNewOrder({
          orderId:   pay.orderId,
          firstName: oData.firstName,
          lastName:  oData.lastName,
          email:     oData.email,
          phone:     oData.phone,
          amount:    pay.amount,
          plan:      'Carte Classique',
        }),
        notifyClientPaymentSuccess({
          firstName:        oData.firstName,
          email:            oData.email,
          amount:           pay.amount,
          loginEmail:       loginEmail,
          password:         pwd,
          leadwaseId:       lwId,
          invoicePdfBase64: invoicePdfBase64, // <-- facture jointe
        }),
      ]);
    }

    // ── PAIEMENT ÉCHOUÉ (carte classique) ─────────────────────────────────────
    if (ko && pay.orderId) {
      const ord   = await db.collection('orders').doc(pay.orderId).get();
      const oData = ord.data();
      await ord.ref.update({ status: 'payment_failed' });

      await Promise.allSettled([
        notifyClientPaymentFailed({
          firstName: oData.firstName,
          email:     oData.email,
          amount:    pay.amount,
        }),
        notifyAdminPaymentFailed({
          orderId:   pay.orderId,
          firstName: oData.firstName,
          lastName:  oData.lastName,
          email:     oData.email,
          amount:    pay.amount,
        }),
      ]);
    }

    // ── ABONNEMENT (PRO ou BUSINESS) - CORRIGÉ ─────────────────────────────────
    if (ok && pay.subscriptionId) {
      const sub   = await db.collection('subscriptions').doc(pay.subscriptionId).get();
      const sData = sub.data();
      const exp   = new Date(); 
      exp.setMonth(exp.getMonth() + 1);
      const expTimestamp = Timestamp.fromDate(exp);

      await sub.ref.update({
        status:     'active',
        startDate:  new Date(),
        expiryDate: expTimestamp,
        paidAt:     new Date(),
      });

      // Récupérer l'UID depuis le payment ou la subscription
      const firebaseUid = pay.firebaseUid || pay.uid || sData?.firebaseUid || sData?.uid;
      
      console.log(`🔍 Recherche du profil avec firebaseUid: ${firebaseUid}`);
      
      if (firebaseUid) {
        // Rechercher le profil par firebaseUid
        const profileQuery = await db.collection('profiles')
          .where('firebaseUid', '==', firebaseUid)
          .limit(1)
          .get();
        
        if (!profileQuery.empty) {
          const profileDoc = profileQuery.docs[0];
          const oldPlan = profileDoc.data().plan || 'free';
          
          // Mettre à jour le plan
          await profileDoc.ref.update({ 
            plan: sData.plan,
            updatedAt: new Date(),
          });
          console.log(`✅ Plan mis à jour: ${oldPlan} → ${sData.plan} pour le profil ${profileDoc.id}`);

          // Génération de la facture PDF pour abonnement
          let invoicePdfBase64 = null;
          try {
            const pData = profileDoc.data();
            invoicePdfBase64 = await generateInvoice({
              invoiceNumber: pay.subscriptionId,
              date:          new Date(),
              firstName:     pData.firstName,
              lastName:      pData.lastName,
              email:         pData.email,
              phone:         pData.phone,
              amount:        sData.amount || pay.amount,
              plan:          `Abonnement Leadwase ${sData.plan?.toUpperCase() || ''}`,
              leadwaseId:    profileDoc.id,
            });
            console.log(`✅ Facture PDF abonnement générée pour ${profileDoc.id}`);
          } catch (pdfError) {
            console.error('❌ Erreur génération facture PDF abonnement:', pdfError);
          }

          // Notifier le client (à adapter selon ta fonction brevo)
          await Promise.allSettled([
            notifyClientPaymentSuccess({
              firstName:        profileDoc.data().firstName,
              email:            profileDoc.data().email,
              amount:           sData.amount || pay.amount,
              loginEmail:       profileDoc.data().loginEmail,
              password:         null, // pas de nouveau mot de passe pour un abonnement
              leadwaseId:       profileDoc.id,
              invoicePdfBase64: invoicePdfBase64, // <-- facture jointe
            }),
          ]);

        } else {
          console.log(`❌ Aucun profil trouvé avec firebaseUid: ${firebaseUid}`);
          
          // Essayer de trouver par leadwaseId si disponible
          if (sData.leadwaseId) {
            const profileById = await db.collection('profiles').doc(sData.leadwaseId).get();
            if (profileById.exists) {
              await profileById.ref.update({ 
                plan: sData.plan,
                firebaseUid: firebaseUid,
                updatedAt: new Date(),
              });
              console.log(`✅ Profil trouvé par leadwaseId ${sData.leadwaseId} mis à jour: plan = ${sData.plan}`);
            }
          }
        }
      } else {
        console.log(`⚠️ Abonnement ${pay.subscriptionId} sans firebaseUid associé`);
      }
    }

    res.json({ received: true, status });
  } catch (e) { 
    console.error('❌ Webhook error:', e);
    res.status(500).json({ error: e.message }); 
  }
}
