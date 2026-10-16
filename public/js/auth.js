import { auth } from './firebase-config.js';
import { signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";

// La connexion se fait uniquement via connexion.html (activation vérifiée côté serveur).
// L'ancienne fonction loginLeadWase (création de compte côté navigateur) a été supprimée : elle permettait
// de s'approprier une carte non activée.

export async function logout() { await signOut(auth); window.location.href = '/'; }
export function onAuth(cb)     { return onAuthStateChanged(auth, cb); }

export async function requireLogin(redirect = '/connexion.html') {
  return new Promise(resolve => {
    const unsub = onAuthStateChanged(auth, user => {
      unsub();
      if (!user) window.location.href = redirect;
      else resolve(user);
    });
  });
}

export async function authHeader() {
  const user = auth.currentUser;
  if (!user) return {};
  const token = await user.getIdToken();
  return { Authorization: 'Bearer ' + token };
}