import { db } from './firebase-config.js';
import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

export async function loadProfile(leadwaseId) {
  const snap = await getDoc(doc(db, 'profiles', leadwaseId.toUpperCase()));
  return snap.exists() ? snap.data() : null;
}

export async function saveProfile(leadwaseId, data) {
  await updateDoc(doc(db, 'profiles', leadwaseId.toUpperCase()), { ...data, updatedAt: new Date() });
}

export function downloadVCard(p) {
  const v = `BEGIN:VCARD\nVERSION:3.0\nFN:${p.firstName} ${p.lastName}\nTITLE:${p.jobTitle||''}\nORG:${p.company||''}\nTEL;TYPE=CELL:${p.phone||''}\nEMAIL:${p.email||''}\nURL:${p.website||''}\nNOTE:LeadWase — leadwase.com/profil/${p.leadwaseId}\nEND:VCARD`;
  Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([v], { type: 'text/vcard' })),
    download: `${p.firstName}_${p.lastName}.vcf`,
  }).click();
}