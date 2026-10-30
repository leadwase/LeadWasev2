// public/js/user-sidebar.js
// Sidebar UNIQUE de l'espace client (dashboard, identifiants, prospects, équipe, analytics).
// Un seul endroit à modifier : ordre, libellés et liens sont identiques sur toutes les pages.
// (Les pages admin ont leur propre sidebar et n'utilisent pas ce fichier.)

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── Lien public opaque (/p/<slug>) du profil de l'utilisateur CONNECTÉ ─────────
// L'identifiant de connexion n'apparaît jamais dans une URL. Tout lien portant data-public-link est
// renseigné dès que le lien est connu (quelle que soit la page : dashboard, analytics, prospects…).
export function applyPublicLink(url) {
  window.__publicUrl = url;
  document.querySelectorAll('[data-public-link]').forEach(a => { a.href = url; });
  document.dispatchEvent(new CustomEvent('public-link-ready', { detail: url }));
}
export function loadPublicLink(user, lwId) {
  if (window.__publicUrl) return Promise.resolve(window.__publicUrl);
  if (window.__publicUrlPromise) return window.__publicUrlPromise;           // un seul appel à la fois
  window.__publicUrlPromise = (async () => {
    try {
      const token = await user.getIdToken();
      const r = await fetch(`/api/profile/${encodeURIComponent(lwId)}?action=public-link`, { headers: { Authorization: 'Bearer ' + token } });
      const d = await r.json();
      if (d.success && d.url) { applyPublicLink(d.url); return d.url; }
    } catch (e) { console.warn('[public-link]', e.message); }
    return null;
  })().finally(() => { window.__publicUrlPromise = null; });
  return window.__publicUrlPromise;
}

// « Tarifs » est remplacé par l'action la plus utile selon l'abonnement actuel
// (celui du chef d'équipe pour les comptes d'une équipe : un seul abonnement pour toute l'équipe).
export function upgradeEntry(plan) {
  if (plan === 'business') return { icon: '⭐', label: 'Mon abonnement', cta: false };
  if (plan === 'pro')      return { icon: '⬆️', label: 'Passer à Business', cta: true };
  return { icon: '⬆️', label: 'Passer à Pro', cta: true };
}

export function renderUserSidebar({ lwId, plan, isTeamOwner, user }) {
  const nav = document.querySelector('.sidebar-nav');
  if (!nav) return;

  const isPro      = ['pro', 'business'].includes(plan);
  const isBusiness = plan === 'business';
  const up = upgradeEntry(plan);
  // /prospects.html ou /prospects (cleanUrls) → "prospects"
  const page = (location.pathname.split('/').pop() || '').replace(/\.html$/, '');

  const item = (key, href, icon, label, external = false, cls = '') => `
      <a class="sidebar-item${key && key === page ? ' active' : ''}${cls ? ' ' + cls : ''}" href="${esc(href)}"${external ? ' target="_blank" rel="noopener"' : ''}${key === 'public' ? ' id="sb-pub" data-public-link' : ''}>
        <span class="s-icon">${icon}</span>${label}
      </a>`;

  nav.innerHTML = `
    <div class="sidebar-section-label">Principal</div>
    ${item('dashboard',   'dashboard.html',   '👤', 'Mon profil')}
    ${item('identifiants','identifiants.html','🔑', 'Identifiants')}
    ${isBusiness   ? item('prospects', 'prospects.html', '📇', 'Mes Prospects') : ''}
    ${isTeamOwner  ? item('equipe',    'equipe.html',    '👥', 'Mon équipe')    : ''}
    ${isPro        ? item('analytics', 'analytics.html', '📊', 'Analytics')     : ''}
    ${item('public', window.__publicUrl || '#', '🔗', 'Profil public', true)}
    ${item('offres', 'offres.html', up.icon, up.label, false, up.cta ? 'sidebar-cta' : '')}
    <div class="sidebar-section-label" style="margin-top:8px">Compte</div>
    ${item('', 'commander.html', '🛒', 'Commander une carte', true)}
    ${item('', 'mailto:contact@leadwase.com', '💬', 'Support')}
    <div class="sidebar-section-label" style="margin-top:8px">Légal</div>
    ${item('', 'cgu.html', '📄', 'CGU', true)}
    ${item('', 'confidentialite.html', '🔒', 'Confidentialité', true)}
  `;

  // Mobile : referme le menu après un clic sur un lien.
  nav.querySelectorAll('.sidebar-item').forEach(a =>
    a.addEventListener('click', () => { if (window.innerWidth <= 800 && window.closeSidebar) window.closeSidebar(); }));

  // « Profil public » : si le lien opaque n'est pas encore prêt, on l'attend puis on ouvre le BON profil
  // (jamais la page courante).
  const pub = document.getElementById('sb-pub');
  if (pub) pub.addEventListener('click', async (e) => {
    if (!pub.getAttribute('href') || pub.getAttribute('href') === '#') {
      e.preventDefault();
      const url = user ? await loadPublicLink(user, lwId) : null;
      if (url) window.open(url, '_blank', 'noopener');
    }
  });
  if (user) loadPublicLink(user, lwId);
}
