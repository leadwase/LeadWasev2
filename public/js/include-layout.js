// public/js/include-layout.js
// Injecte le header et le footer partagés (public/partials/header.html et
// footer.html) dans tous les points d'ancrage <div id="site-header">/<div
// id="site-footer">, met en surbrillance le lien de nav actif, et adapte le
// lien "Connexion" ⇄ "Mon profil" selon l'état d'authentification.
import { auth } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js';

async function injectPartial(placeholderId, url) {
  const el = document.getElementById(placeholderId);
  if (!el) return;
  const html = await fetch(url).then(r => r.text());
  el.outerHTML = html;
}

async function initLayout() {
  await Promise.all([
    injectPartial('site-header', '/partials/header.html'),
    injectPartial('site-footer', '/partials/footer.html'),
  ]);

  // Surligne le lien de nav correspondant à la page courante.
  const current = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.main-nav .nav-item').forEach(a => {
    const href = a.getAttribute('href').split('/').pop();
    if (href === current || (current === '' && href === 'index.html')) a.classList.add('active');
  });

  // Connexion ⇄ Mon profil selon l'état d'authentification.
  onAuthStateChanged(auth, user => {
    const el = document.getElementById('nav-auth');
    if (el && user) { el.textContent = 'Mon profil'; el.href = '/dashboard.html'; }
  });

  document.dispatchEvent(new CustomEvent('layout:ready'));
}

initLayout();
