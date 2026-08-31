// public/js/dashboard-shared.js
// Logique commune aux pages de l'espace client (dashboard.html, identifiants.html,
// analytics.html) : initialisation Firebase, garde d'authentification, remplissage
// de la sidebar, helpers partagés.

import { initializeApp }   from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut }
                            from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js';
import { getFirestore, doc, getDoc }
                            from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';

const cfg  = await fetch('/api/config').then(r => r.json());
const app  = initializeApp(cfg, 'client-app');
export const auth = getAuth(app);
export const db   = getFirestore(app);

export function lwIdFromInternalEmail(email) {
  if (!email) return null;
  const match = email.match(/^(lw-\d+)@leadwase\.internal$/i);
  return match ? match[1].toUpperCase() : null;
}

// ── Toast notification ───────────────────────────────────────────────────────
export function toast(msg, type) {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── Confirmation modale (remplace window.confirm) ─────────────────────────────
let confirmModalEl = null;
function ensureConfirmModal() {
  if (confirmModalEl) return confirmModalEl;
  const el = document.createElement('div');
  el.className = 'lw-confirm-overlay';
  el.innerHTML = `
    <div class="lw-confirm-box">
      <div class="lw-confirm-msg"></div>
      <div class="lw-confirm-field" style="display:none"><textarea class="lw-confirm-input" rows="3"></textarea></div>
      <div class="lw-confirm-actions">
        <button class="lw-confirm-cancel">Annuler</button>
        <button class="lw-confirm-ok">Confirmer</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  confirmModalEl = el;
  return el;
}
export function confirmDialog(message, { okLabel = 'Confirmer', danger = false } = {}) {
  const el = ensureConfirmModal();
  el.querySelector('.lw-confirm-msg').textContent = message;
  el.querySelector('.lw-confirm-field').style.display = 'none';
  const okBtn = el.querySelector('.lw-confirm-ok');
  const cancelBtn = el.querySelector('.lw-confirm-cancel');
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
export function promptDialog(message, { defaultValue = '', okLabel = 'Enregistrer' } = {}) {
  const el = ensureConfirmModal();
  el.querySelector('.lw-confirm-msg').textContent = message;
  const field = el.querySelector('.lw-confirm-field');
  const input = el.querySelector('.lw-confirm-input');
  field.style.display = 'block';
  input.value = defaultValue;
  const okBtn = el.querySelector('.lw-confirm-ok');
  const cancelBtn = el.querySelector('.lw-confirm-cancel');
  okBtn.textContent = okLabel;
  okBtn.classList.remove('danger');
  el.classList.add('open');
  setTimeout(() => input.focus(), 50);
  return new Promise((resolve) => {
    const cleanup = (result) => { el.classList.remove('open'); resolve(result); };
    okBtn.onclick = () => cleanup(input.value);
    cancelBtn.onclick = () => cleanup(null);
    el.onclick = (e) => { if (e.target === el) cleanup(null); };
  });
}

// ── Code public (masqué) ─────────────────────────────────────────────────────
export function getPublicCode(lwId) {
  if (!lwId) return 'LW-????';
  if (lwId.startsWith('LW-')) {
    const base = lwId.substring(3, 6);
    return `LW-${base}***`;
  }
  let hash = 0;
  for (let i = 0; i < lwId.length; i++) {
    hash = ((hash << 5) - hash) + lwId.charCodeAt(i);
    hash |= 0;
  }
  const positiveHash = Math.abs(hash).toString(36).substring(0, 6).toUpperCase();
  return `LW-${positiveHash}`;
}

// ── Mobile sidebar ────────────────────────────────────────────────────────────
window.toggleSidebar = () => {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('overlay').classList.toggle('active');
  document.getElementById('hamburger').classList.toggle('open');
};
window.closeSidebar = () => {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('active');
  document.getElementById('hamburger').classList.remove('open');
};

// ── Déconnexion ──────────────────────────────────────────────────────────────
window.doLogout = async () => {
  await signOut(auth);
  window.location.href = '/';
};

// ── Garde d'authentification + chargement du profil ──────────────────────────
// Appeler depuis chaque page avec un callback recevant { user, p, lwId, plan, isPro, isBusiness, currentLoginEmail }.
export function initDashboardAuth(onReady) {
  onAuthStateChanged(auth, async user => {
    if (!user) { window.location.href = '/connexion.html'; return; }

    const uDoc = await getDoc(doc(db, 'users', user.uid));
    const ud   = uDoc.exists() ? uDoc.data() : {};
    const plan = ud.plan || 'free';

    let lwId = ud.leadwaseId || null;
    let profileDoc = null;

    if (lwId) {
      profileDoc = await getDoc(doc(db, 'profiles', lwId));
      if (!profileDoc.exists()) profileDoc = null;
    }
    if (!profileDoc) {
      const lwIdFromEmail = lwIdFromInternalEmail(user.email);
      if (lwIdFromEmail) {
        lwId = lwIdFromEmail;
        profileDoc = await getDoc(doc(db, 'profiles', lwId));
        if (!profileDoc.exists()) profileDoc = null;
      }
    }
    if (!profileDoc) {
      await signOut(auth);
      window.location.href = 'connexion.html?msg=identifiants';
      return;
    }

    const p = profileDoc.data();
    if (p.disabled) {
      await signOut(auth);
      window.location.href = 'connexion.html?msg=disabled';
      return;
    }
    const planFinal = p.plan || plan;
    const isPro     = ['pro', 'business'].includes(planFinal);
    const isBusiness = planFinal === 'business';

    document.getElementById('app-layout').style.display = '';

    // Sidebar (commune à toutes les pages de l'espace client)
    document.getElementById('sb-av').textContent   = (p.firstName || '?')[0];
    document.getElementById('sb-name').textContent = (p.firstName || '') + ' ' + (p.lastName || '');
    document.getElementById('sb-plan').textContent = planFinal.toUpperCase();
    const sbPub = document.getElementById('sb-pub');
    if (sbPub) { sbPub.href = 'profil.html?id=' + lwId; sbPub.target = '_blank'; sbPub.rel = 'noopener'; }
    const analyticsNav = document.getElementById('analytics-nav-item');
    if (isPro && analyticsNav) {
      analyticsNav.innerHTML = '<a class="sidebar-item" href="analytics.html"><span class="s-icon">📊</span>Analytics</a>';
    }
    const prospectsNav = document.getElementById('prospects-nav-item');
    if (isBusiness && prospectsNav) {
      const current = location.pathname.split('/').pop();
      const active  = current === 'prospects.html' ? ' active' : '';
      prospectsNav.innerHTML = `<a class="sidebar-item${active}" href="prospects.html"><span class="s-icon">📇</span>Mes Prospects</a>`;
    }
    const teamNav = document.getElementById('team-nav-item');
    if (p.isTeamOwner && teamNav) {
      const current = location.pathname.split('/').pop();
      const active  = current === 'equipe.html' ? ' active' : '';
      teamNav.innerHTML = `<a class="sidebar-item${active}" href="equipe.html"><span class="s-icon">👥</span>Mon équipe</a>`;
    }

    let currentLoginEmail = user.email;
    try {
      const credDoc = await getDoc(doc(db, 'credentials', lwId));
      if (credDoc.exists()) currentLoginEmail = credDoc.data().loginEmail || user.email;
    } catch (e) { /* pas bloquant */ }

    onReady({ user, p, lwId, plan: planFinal, isPro, isBusiness, currentLoginEmail });

    document.getElementById('loader').style.display  = 'none';
    document.getElementById('content').style.display = '';
  });
}
