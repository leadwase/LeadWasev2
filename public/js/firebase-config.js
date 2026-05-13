import { initializeApp }  from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getAuth }        from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import { getFirestore }   from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

const res    = await fetch('/api/config');
const config = await res.json();

const _app = initializeApp(config);
export const auth = getAuth(_app);
export const db   = getFirestore(_app);
export const API  = '/api';