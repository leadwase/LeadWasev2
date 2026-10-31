// public/admin/js/bulk-delete.js
// Suppression unitaire / en masse / « tout vider » pour les tableaux admin (commandes, paiements, abonnements, B2B).
// Le tableau doit rendre ses lignes avec  <tr data-id="…" data-status="…">.  Ce module ajoute tout seul :
//   • une case à cocher (+ « tout sélectionner ») et un bouton 🗑 sur chaque ligne supprimable,
//   • un 🔒 sur les lignes protégées (payées, livrées, actives…),
//   • une barre d'outils : « Supprimer la sélection » et « Vider … » par statut.
// Les règles de protection sont appliquées côté serveur (lib/adminDelete.js) : cette interface n'est qu'un confort.
import { api, confirmDialog, toast, esc } from './admin-shared.js';

export function attachBulkDelete({ tbody, route, deletable, purges = [], reload, noun = 'élément', fem = false }) {
  const e_ = fem ? 'e' : '';                     // accord : supprimé(e)(s), conservé(e)(s)
  const table = tbody.closest('table');
  const host = table.closest('.table-wrap') || table;
  const OK = new Set(deletable);
  const selected = new Set();

  // ── Barre d'outils ────────────────────────────────────────────────────────
  const bar = document.createElement('div');
  bar.className = 'bd-toolbar';
  bar.innerHTML = `
    <span class="bd-count">0 sélectionné</span>
    <button type="button" class="act-btn bd-danger" data-bd="sel" disabled>🗑 Supprimer la sélection</button>
    <span class="bd-sep"></span>
    ${purges.map(p => `<button type="button" class="act-btn bd-danger" data-bd="purge" data-status="${esc(p.status)}">🧹 Vider « ${esc(p.label)} » <span class="bd-n">(0)</span></button>`).join('')}`;
  host.parentNode.insertBefore(bar, host);

  const rowsOf = () => [...tbody.querySelectorAll('tr[data-id]')];
  const chkOf = () => [...tbody.querySelectorAll('.bd-chk')];

  function refreshBar() {
    const ids = new Set(rowsOf().map(r => r.dataset.id));
    [...selected].forEach(id => { if (!ids.has(id)) selected.delete(id); });          // lignes disparues (filtre / rechargement)
    bar.querySelector('.bd-count').textContent = `${selected.size} sélectionné${selected.size > 1 ? 's' : ''}`;
    bar.querySelector('[data-bd="sel"]').disabled = selected.size === 0;
    bar.querySelectorAll('[data-bd="purge"]').forEach(b => {
      const n = rowsOf().filter(r => r.dataset.status === b.dataset.status).length;
      b.querySelector('.bd-n').textContent = `(${n})`;
      b.disabled = n === 0;
    });
    const all = document.getElementById(allId);
    const boxes = chkOf();
    if (all) all.checked = boxes.length > 0 && boxes.every(c => c.checked);
  }

  // ── En-tête du tableau ────────────────────────────────────────────────────
  const allId = 'bd-all-' + Math.random().toString(36).slice(2, 7);
  const headRow = table.querySelector('thead tr');
  if (headRow && !headRow.dataset.bd) {
    headRow.dataset.bd = '1';
    headRow.insertAdjacentHTML('afterbegin', `<th style="width:36px"><input type="checkbox" id="${allId}" title="Tout sélectionner (lignes supprimables affichées)"></th>`);
    headRow.insertAdjacentHTML('beforeend', '<th style="width:48px"></th>');
  }

  // ── Lignes : cases et bouton 🗑 ajoutés après chaque rendu ───────────────
  function enhance() {
    tbody.querySelectorAll('tr.empty-row td[colspan]').forEach(td => {
      if (!td.dataset.bd) { td.dataset.bd = '1'; td.colSpan = (parseInt(td.getAttribute('colspan'), 10) || 1) + 2; }
    });
    rowsOf().forEach(tr => {
      if (tr.dataset.bd) return;
      tr.dataset.bd = '1';
      const id = tr.dataset.id, can = OK.has(tr.dataset.status);
      tr.insertAdjacentHTML('afterbegin', can
        ? `<td><input type="checkbox" class="bd-chk" data-id="${esc(id)}" ${selected.has(id) ? 'checked' : ''}></td>`
        : `<td title="Protégé : payé, livré, actif ou traité" style="text-align:center;opacity:.55">🔒</td>`);
      tr.insertAdjacentHTML('beforeend', can
        ? `<td><button type="button" class="act-btn bd-danger bd-one" data-id="${esc(id)}" title="Supprimer">🗑</button></td>` : '<td></td>');
    });
    refreshBar();
  }
  new MutationObserver(enhance).observe(tbody, { childList: true });
  enhance();

  // ── Interactions ──────────────────────────────────────────────────────────
  tbody.addEventListener('change', (e) => {
    const c = e.target.closest('.bd-chk'); if (!c) return;
    if (c.checked) selected.add(c.dataset.id); else selected.delete(c.dataset.id);
    refreshBar();
  });
  table.addEventListener('change', (e) => {
    if (e.target.id !== allId) return;
    chkOf().forEach(c => { c.checked = e.target.checked; if (c.checked) selected.add(c.dataset.id); else selected.delete(c.dataset.id); });
    refreshBar();
  });
  tbody.addEventListener('click', (e) => {
    const b = e.target.closest('.bd-one'); if (b) deleteIds([b.dataset.id]);
  });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-bd]'); if (!b || b.disabled) return;
    if (b.dataset.bd === 'sel') deleteIds([...selected]);
    else purge(b.dataset.status, b.textContent.replace(/🧹|\(\d+\)/g, '').trim());
  });

  function report(deleted, skipped) {
    let msg = `${deleted} ${noun}${deleted > 1 ? 's' : ''} supprimé${e_}${deleted > 1 ? 's' : ''}`;
    if (skipped && skipped.length) msg += ` · ${skipped.length} conservé${e_}${skipped.length > 1 ? 's' : ''} (${skipped[0].reason})`;
    toast(msg, deleted ? 'success' : 'error');
  }

  async function deleteIds(ids) {
    if (!ids.length) return;
    const ok = await confirmDialog(
      `Supprimer définitivement ${ids.length} ${noun}${ids.length > 1 ? 's' : ''} ? Cette action est irréversible.`,
      { okLabel: 'Supprimer', danger: true });
    if (!ok) return;
    try {
      const d = await api(route, { method: 'POST', body: JSON.stringify({ ids }) });
      if (!d.success) throw new Error(d.error || 'Erreur inconnue');
      ids.forEach(i => selected.delete(i));
      report(d.deleted, d.skipped);
      await reload();
    } catch (e) { toast('Erreur : ' + e.message, 'error'); }
  }

  async function purge(status, label) {
    const ok = await confirmDialog(
      `Supprimer ${fem ? 'TOUTES' : 'TOUS'} les ${noun}s au statut « ${label} » ? Les éléments payés, livrés ou actifs sont protégés. Cette action est irréversible.`,
      { okLabel: 'Tout supprimer', danger: true });
    if (!ok) return;
    try {
      let total = 0, skipped = [];
      for (let i = 0; i < 10; i++) {                         // 400 éléments par appel : on enchaîne jusqu'à épuisement
        const d = await api(route, { method: 'POST', body: JSON.stringify({ status }) });
        if (!d.success) throw new Error(d.error || 'Erreur inconnue');
        total += d.deleted; skipped = skipped.concat(d.skipped || []);
        if (!d.more || d.deleted === 0) break;
      }
      report(total, skipped);
      await reload();
    } catch (e) { toast('Erreur : ' + e.message, 'error'); }
  }
}
