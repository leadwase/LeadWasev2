// public/js/prices.js
// Prix affichés sur le site = prix saisis dans Admin → Paramètres (settings/prices).
// Dans le HTML, on met le prix dans <data data-price="classic|pro|business">25 500</data> :
// la valeur écrite en dur sert de repli si l'API est indisponible, et reste masquée
// jusqu'à la réponse pour ne jamais afficher un ancien prix.

export const fmtPrice = (n) => Math.round(Number(n) || 0).toLocaleString('fr-FR');

export async function loadPrices() {
  try {
    const r = await fetch('/api/config?action=prices');
    const d = await r.json();
    if (!r.ok || !d.success || !d.prices) throw new Error('prix indisponibles');
    return d.prices;
  } catch (e) {
    console.warn('[prices]', e.message);
    return null;
  }
}

export function applyPrices(prices) {
  if (prices) {
    document.querySelectorAll('[data-price]').forEach(el => {
      const v = Number(prices[el.dataset.price]);
      if (v > 0) el.textContent = fmtPrice(v);
    });
  }
  document.documentElement.classList.add('prices-ready');
}

export async function initPrices() {
  setTimeout(() => document.documentElement.classList.add('prices-ready'), 3000); // ne jamais laisser un prix masqué
  const prices = await loadPrices();
  applyPrices(prices);
  return prices;
}
