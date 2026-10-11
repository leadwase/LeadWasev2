// public/js/user-sidebar.js
// Sidebar UNIQUE de l'espace client (dashboard, identifiants, prospects, équipe, analytics).
// Un seul endroit à modifier : ordre, libellés et liens sont identiques sur toutes les pages.
// (Les pages admin ont leur propre sidebar et n'utilisent pas ce fichier.)

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderUserSidebar({ lwId, plan, isTeamOwner }) {
  const nav = document.querySelector('.sidebar-nav');
  if (!nav) return;

  const isPro      = ['pro', 'business'].includes(plan);
  const isBusiness = plan === 'business';
  // /prospects.html ou /prospects (cleanUrls) → "prospects"
  const page = (location.pathname.split('/').pop() || '').replace(/\.html$/, '');

  const item = (key, href, icon, label, external = false) => `
      <a class="sidebar-item${key && key === page ? ' active' : ''}" href="${esc(href)}"${external ? ' target="_blank" rel="noopener"' : ''}${key === 'public' ? ' id="sb-pub"' : ''}>
        <span class="s-icon">${icon}</span>${label}
      </a>`;

  nav.innerHTML = `
    <div class="sidebar-section-label">Principal</div>
    ${item('dashboard',   'dashboard.html',   '👤', 'Mon profil')}
    ${item('identifiants','identifiants.html','🔑', 'Identifiants')}
    ${isBusiness   ? item('prospects', 'prospects.html', '📇', 'Mes Prospects') : ''}
    ${isTeamOwner  ? item('equipe',    'equipe.html',    '👥', 'Mon équipe')    : ''}
    ${isPro        ? item('analytics', 'analytics.html', '📊', 'Analytics')     : ''}
    ${item('offres', 'offres.html', '⭐', 'Offres', true)}
    ${item('public', lwId ? 'profil.html?id=' + encodeURIComponent(lwId) : '#', '🔗', 'Profil public', true)}
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
}
