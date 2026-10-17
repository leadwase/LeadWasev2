// public/js/include-layout.js
// Injecte le header et le footer partagés (public/partials/header.html et
// footer.html) dans tous les points d'ancrage <div id="site-header">/<div
// id="site-footer">, met en surbrillance le lien de nav actif, et adapte le
// lien "Connexion" ⇄ "Mon profil" selon l'état d'authentification.
// Le header/footer ne dépendent PAS de Firebase : s'il est lent ou bloqué, le menu s'affiche quand même.
// (Firebase n'est chargé qu'ensuite, uniquement pour basculer « Connexion » → « Mon profil ».)

async function injectPartial(placeholderId, url) {
  const el = document.getElementById(placeholderId);
  if (!el) return;
  try {
    const html = await fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r.text(); });
    el.outerHTML = html;
  } catch (e) { console.warn('[layout]', url, e.message); }
}

async function initLayout() {
  await Promise.all([
    injectPartial('site-header', '/partials/header.html'),
    injectPartial('site-footer', '/partials/footer.html'),
  ]);

  // Surligne le lien de nav correspondant à la page courante.
  const current = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.main-nav .nav-item, .nav-mobile-panel .nav-mobile-item').forEach(a => {
    const href = a.getAttribute('href').split('/').pop();
    if (href === current || (current === '' && href === 'index.html')) a.classList.add('active');
  });

  // Menu mobile (hamburger).
  const burger = document.getElementById('nav-burger');
  const panel  = document.getElementById('nav-mobile-panel');
  if (burger && panel) {
    burger.addEventListener('click', () => {
      const open = panel.classList.toggle('open');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    panel.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
      panel.classList.remove('open');
      burger.setAttribute('aria-expanded', 'false');
    }));
  }

  document.dispatchEvent(new CustomEvent('layout:ready'));

  // Connexion ⇄ Mon profil selon l'état d'authentification (best effort, après l'affichage).
  try {
    const [{ auth }, { onAuthStateChanged }] = await Promise.all([
      import('./firebase-config.js'),
      import('https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js'),
    ]);
    onAuthStateChanged(auth, user => {
      [document.getElementById('nav-auth'), document.getElementById('nav-auth-mobile')].forEach(el => {
        if (el && user) { el.textContent = 'Mon profil'; el.href = '/dashboard.html'; }
      });
    });
  } catch (e) { console.warn('[layout] état de connexion indisponible :', e.message); }
}

initLayout();
