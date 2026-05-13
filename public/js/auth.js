import { auth, db } from './firebase-config.js';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

const toEmail = id => id.toLowerCase().trim() + '@leadwase.internal';

export async function loginLeadWase(leadwaseId, password) {
  const email = toEmail(leadwaseId);
  try {
    await signInWithEmailAndPassword(auth, email, password);
    return { success: true };
  } catch {}

  const cDoc = await getDoc(doc(db, 'credentials', leadwaseId.toUpperCase()));
  if (!cDoc.exists()) return { success: false, error: 'Identifiant introuvable' };
  if (cDoc.data().passwordHash !== password) return { success: false, error: 'Mot de passe incorrect' };

  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await setDoc(doc(db, 'users', cred.user.uid), {
      leadwaseId: leadwaseId.toUpperCase(), plan: 'free', role: 'user', createdAt: new Date(),
    }, { merge: true });
  } catch {}

  try {
    await signInWithEmailAndPassword(auth, email, password);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
}

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