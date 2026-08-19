// public/admin/js/admin-shared.js
// Logique commune à toutes les pages du tableau de bord admin :
// authentification Firebase, appel API, sidebar, helpers de formatage, modal.

import { initializeApp }    from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, getIdToken }
                            from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js';

const cfg  = await fetch('/api/config').then(r => r.json());
const app  = initializeApp(cfg, 'admin-app');
const auth = getAuth(app);
let TOKEN  = null;

// ── API helper ────────────────────────────────────────────────
// Chaque route admin est maintenant un endpoint dédié : /api/admin/<route>
export async function api(route, opts = {}) {
  TOKEN = await getIdToken(auth.currentUser);
  const url = `/api/admin/${route}`;
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN, ...(opts.headers || {}) },
  });
  return res.json();
}

// ── Formatage ─────────────────────────────────────────────────
export function fmtDate(v) {
  if (!v) return '—';
  const d = v._seconds ? new Date(v._seconds * 1000) : new Date(v);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
export function fmtDateTime(v) {
  if (!v) return '—';
  const d = v._seconds ? new Date(v._seconds * 1000) : new Date(v);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function fmtNum(n) { return (n || 0).toLocaleString('fr-FR'); }
export function badge(s) {
  const map = { pending: 'b-pending', paid: 'b-paid', delivered: 'b-delivered', failed: 'b-failed',
    success: 'b-success', payment_failed: 'b-failed', gateway_error: 'b-failed',
    active: 'b-paid', free: 'b-pending', b2b_pending: 'b-encours', b2b_done: 'b-delivered',
    cancelled: 'b-failed', expired: 'b-failed' };
  const labels = { pending: 'EN ATTENTE', paid: 'PAYÉ', delivered: 'LIVRÉ', failed: 'ÉCHOUÉ',
    success: 'SUCCÈS', payment_failed: 'ÉCHOUÉ', gateway_error: 'ERREUR',
    active: 'ACTIF', free: 'FREE', b2b_pending: 'EN COURS', b2b_done: 'TRAITÉ',
    cancelled: 'ANNULÉ', expired: 'EXPIRÉ' };
  return `<span class="badge ${map[s] || 'b-pending'}">${labels[s] || s || '—'}</span>`;
}
export function shortId(id) { return id ? '#' + id.slice(-6).toUpperCase() : '—'; }

// ── Confirmation / saisie modales (remplacent window.confirm / window.prompt) ──
let confirmModalEl = null;
function ensureConfirmModal() {
  if (confirmModalEl) return confirmModalEl;
  const el = document.createElement('div');
  el.className = 'adm-confirm-overlay';
  el.innerHTML = `
    <div class="adm-confirm-box">
      <div class="adm-confirm-msg"></div>
      <div class="adm-confirm-field" style="display:none"><input type="text" class="adm-confirm-input"></div>
      <div class="adm-confirm-actions">
        <button class="adm-confirm-cancel">Annuler</button>
        <button class="adm-confirm-ok">Confirmer</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  confirmModalEl = el;
  return el;
}
export function confirmDialog(message, { okLabel = 'Confirmer', danger = false } = {}) {
  const el = ensureConfirmModal();
  el.querySelector('.adm-confirm-msg').textContent = message;
  el.querySelector('.adm-confirm-field').style.display = 'none';
  const okBtn = el.querySelector('.adm-confirm-ok');
  const cancelBtn = el.querySelector('.adm-confirm-cancel');
  okBtn.textContent = okLabel;
  okBtn.classList.toggle('danger', !!danger);
  el.classList.add('open');
  return new Promise((resolve) => {
    const cleanup = (result) => { el.classList.remove('open'); resolve(result); };
    okBtn.onclick = () => cleanup(true);
    cancelBtn.onclick = () => cleanup(false);
    el.onclick = (e) => { if (e.target === el) cleanup(false); };
  });
}
export function promptDialog(message, { defaultValue = '', okLabel = 'Valider' } = {}) {
  const el = ensureConfirmModal();
  el.querySelector('.adm-confirm-msg').textContent = message;
  const field = el.querySelector('.adm-confirm-field');
  const input = el.querySelector('.adm-confirm-input');
  field.style.display = 'block';
  input.value = defaultValue;
  const okBtn = el.querySelector('.adm-confirm-ok');
  const cancelBtn = el.querySelector('.adm-confirm-cancel');
  okBtn.textContent = okLabel;
  okBtn.classList.remove('danger');
  el.classList.add('open');
  setTimeout(() => input.focus(), 50);
  return new Promise((resolve) => {
    const cleanup = (result) => { el.classList.remove('open'); resolve(result); };
    okBtn.onclick = () => cleanup(input.value);
    cancelBtn.onclick = () => cleanup(null);
    input.onkeydown = (e) => { if (e.key === 'Enter') cleanup(input.value); };
    el.onclick = (e) => { if (e.target === el) cleanup(null); };
  });
}

// ── Notification toast (remplace window.alert) ──────────────────────────────
export function toast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = 'adm-toast ' + type;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

export function orderRow(o, showId) {
  const shortId_ = o.id ? '#CMD-' + o.id.slice(-4).toUpperCase() : '—';
  const action = o.leadwaseId
    ? (showId ? `<button class="act-btn btn-view" onclick="showDetail('${o.id}')">Voir profil</button>` : `<button class="act-btn btn-done" disabled>✓ Livré</button>`)
    : o.status === 'paid'
      ? `<button class="act-btn btn-gen" onclick="generateAccess('${o.id}')">Générer accès</button>`
      : `<span style="color:var(--gray4);font-size:13px">—</span>`;
  const idCell = showId ? `<td style="font-family:'Space Mono',monospace;color:var(--green);font-size:13px">${o.leadwaseId || '—'}</td>` : '';
  return `<tr>
    <td style="font-family:'Space Mono',monospace;font-size:13px;color:var(--gray4)">${shortId_}</td>
    <td style="font-weight:600">${o.firstName || ''} ${o.lastName || ''}</td>
    <td>${o.cardType === 'b2b' ? 'B2B' : 'Classique'}</td>
    <td style="font-weight:600;color:var(--green)">${o.amount ? fmtNum(o.amount) + ' FCFA' : 'Sur devis'}</td>
    <td style="color:var(--gray4)">${fmtDate(o.createdAt)}</td>
    <td>${badge(o.status)}</td>
    ${idCell}
    <td>${action}</td>
  </tr>`;
}

// ── Modal détail commande (partagé par plusieurs pages) ────────
export async function showDetail(orderId) {
  try {
    const d = await api('orders');
    const o = d.orders?.find(x => x.id === orderId);
    if (!o) return;
    document.getElementById('modal-title').textContent = 'Commande #CMD-' + orderId.slice(-4).toUpperCase();
    document.getElementById('modal-body').innerHTML = [
      ['Client', `${o.firstName || ''} ${o.lastName || ''}`],
      ['Email', o.email || '—'], ['Téléphone', o.phone || '—'],
      ['Entreprise', o.company || '—'], ['Poste', o.jobTitle || '—'],
      ['Type', o.cardType || '—'], ['Montant', o.amount ? fmtNum(o.amount) + ' FCFA' : '—'],
      ['Statut', o.status || '—'], ['ID LeadWase', o.leadwaseId || '—'],
      ['Date', fmtDate(o.createdAt)], ['Adresse', o.address || '—'],
    ].map(([k, v]) => `<div class="detail-row"><span class="detail-key">${k}</span><span class="detail-val">${v}</span></div>`).join('');
    document.getElementById('detail-modal').classList.add('open');
  } catch (e) { console.error(e); }
}
export function closeModal() { document.getElementById('detail-modal')?.classList.remove('open'); }
window.showDetail = showDetail;
window.closeModal = closeModal;

// Génère les accès (identifiant + mot de passe) pour une commande payée,
// directement depuis la liste (remplace l'ancien renvoi vers une page inexistante).
window.generateAccess = async (orderId) => {
  const ok = await confirmDialog('Générer les identifiants de connexion pour cette commande ?', { okLabel: 'Générer' });
  if (!ok) return;
  try {
    const d = await api('orders?action=generate-credentials', { method: 'POST', body: JSON.stringify({ orderId }) });
    if (!d.success) throw new Error(d.error || 'Erreur inconnue');
    toast(`✅ Accès générés — Identifiant : ${d.leadwaseId} / Mot de passe : ${d.password || '(déjà généré précédemment)'}`, 'success');
    document.dispatchEvent(new CustomEvent('admin:orders-updated'));
  } catch (e) {
    toast('❌ Erreur : ' + e.message, 'error');
  }
};

// ── Copie presse-papier ─────────────────────────────────────────
window.copyText = (text) => navigator.clipboard.writeText(text);
window.copyFullCredentials = (lid, login, pwd) => {
  navigator.clipboard.writeText(`🔐 Vos identifiants LeadWase :\nIdentifiant : ${login}\nMot de passe : ${pwd}`);
  toast('✅ Identifiants copiés !', 'success');
};

// ── Sidebar / topbar ─────────────────────────────────────────────
window.toggleSidebar = () => {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sb-overlay').classList.toggle('open');
};
window.closeSidebar = () => {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sb-overlay').classList.remove('open');
};

async function loadSidebarCounts() {
  try {
    const [statsRes, b2bRes, credRes] = await Promise.allSettled([api('payments?action=stats'), api('b2b'), api('credentials')]);
    if (statsRes.status === 'fulfilled' && statsRes.value.success) {
      document.getElementById('sb-pending-count').textContent = statsRes.value.stats.pendingOrders || 0;
    }
    if (b2bRes.status === 'fulfilled' && b2bRes.value.success) {
      document.getElementById('sb-b2b-count').textContent = b2bRes.value.orders.filter(o => o.status === 'b2b_pending').length;
    }
    if (credRes.status === 'fulfilled' && credRes.value.success) {
      document.getElementById('sb-cred-count').textContent = credRes.value.credentials.length;
    }
  } catch (e) { console.error('sidebar counts', e); }
}

// ── Auth : à appeler depuis chaque page avec sa fonction de chargement ──
export function initAuth(onReady) {
  document.getElementById('topbar-date').textContent =
    new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  onAuthStateChanged(auth, async user => {
    if (user) {
      TOKEN = await getIdToken(user);
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('app').style.display = 'block';
      document.getElementById('sb-user-email').textContent = user.email;
      loadSidebarCounts();
      onReady?.();
    } else {
      TOKEN = null;
      document.getElementById('login-screen').style.display = 'flex';
      document.getElementById('app').style.display = 'none';
    }
  });

  window.doLogin = async () => {
    const btn = document.getElementById('login-btn');
    const err = document.getElementById('login-err');
    err.textContent = '';
    btn.disabled = true; btn.textContent = 'Connexion...';
    try {
      await signInWithEmailAndPassword(auth,
        document.getElementById('l-email').value.trim(),
        document.getElementById('l-pwd').value);
    } catch {
      err.textContent = 'Email ou mot de passe incorrect.';
      btn.disabled = false; btn.textContent = 'Accéder au dashboard';
    }
  };
  document.getElementById('l-pwd').addEventListener('keydown', e => { if (e.key === 'Enter') window.doLogin(); });
  window.doLogout = () => signOut(auth);

  document.getElementById('detail-modal')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
}
