// lib/getPrices.js
// Utilitaire partagé — lit les prix dans Firestore settings/prices
// Utilisé par /api/order.js et /api/subscribe.js

import { getFirestore } from 'firebase-admin/firestore';

const DEFAULT_PRICES = { classic: 25000, pro: 3500, business: 9900 };

export async function getPrices() {
  try {
    const db   = getFirestore();
    const snap = await db.collection('settings').doc('prices').get();
    if (snap.exists) {
      const data = snap.data();
      return {
        classic:  data.classic  || DEFAULT_PRICES.classic,
        pro:      data.pro      || DEFAULT_PRICES.pro,
        business: data.business || DEFAULT_PRICES.business,
      };
    }
  } catch (e) {
    console.warn('[getPrices] fallback sur valeurs par défaut :', e.message);
  }
  return DEFAULT_PRICES;
}
