import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp }       from 'firebase-admin/firestore';
import { getAuth }                        from 'firebase-admin/auth';
import {
  notifyAdminNewOrder,
  notifyClientPaymentSuccess,
  notifyClientPaymentFailed,
  notifyAdminPaymentFailed,
} from '../brevo.js';

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
          firstName: oData.firstName,
          email:     oData.email,
          amount:    pay.amount,
          loginEmail: loginEmail,
          password: pwd,
          leadwaseId: lwId,
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
