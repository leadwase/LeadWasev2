import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getAuth, setPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

const res = await fetch('/api/config');
const config = await res.json();

const _app = initializeApp(config);
export const auth = getAuth(_app);
export const db = getFirestore(_app);
export const API = '/api';
// Session isolée par onglet : évite qu'une connexion écrase une autre session
// (admin ou client) ouverte ailleurs dans le même navigateur.
await setPersistence(auth, browserSessionPersistence);
