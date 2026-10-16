// lib/getPrices.js
// Source unique des tarifs : settings/prices (modifiable dans Admin → Paramètres).
// Utilisé par les APIs de commande / d'abonnement et par /api/config?action=prices (affichage sur le site).
//  - classic / pro / business : carte (FCFA) et abonnements mensuels (FCFA/mois)
//  - b2bPro / b2bBusiness     : abonnements ENTREPRISES, prix annuel par carte employé (FCFA/an)

import { getFirestore } from 'firebase-admin/firestore';

export const DEFAULT_PRICES = { classic: 25000, pro: 3500, business: 9900, b2bPro: 5500, b2bBusiness: 7500 };

export async function getPrices() {
  try {
    const db   = getFirestore();
    const snap = await db.collection('settings').doc('prices').get();
    if (snap.exists) {
      const data = snap.data();
      const pick = (k) => (Number(data[k]) > 0 ? Number(data[k]) : DEFAULT_PRICES[k]);
      return {
        classic: pick('classic'), pro: pick('pro'), business: pick('business'),
        b2bPro: pick('b2bPro'), b2bBusiness: pick('b2bBusiness'),
      };
    }
  } catch (e) {
    console.warn('[getPrices] fallback sur valeurs par défaut :', e.message);
  }
  return { ...DEFAULT_PRICES };
}
