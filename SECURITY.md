# Sécurité LeadWase — état et actions restantes

## Corrigé dans le code
- **URL de profil** : `/p/<code aléatoire>` (12 caractères, non devinable). L'identifiant de connexion `LW-xxxxx` n'apparaît plus dans l'adresse ; les anciens liens NFC `?id=LW-…` fonctionnent encore et sont réécrits en `/p/…` à l'affichage.
- **Profil public filtré** : l'API ne renvoie plus que les champs publics (plus d'identifiant, d'UID, d'équipe, de prix négocié, d'abonnement). La page publique n'accède plus à Firestore ; suivi des visites côté serveur.
- **Prise de contrôle de carte non activée** : la première connexion créait le compte côté navigateur avec n'importe quel mot de passe. L'activation est maintenant vérifiée côté serveur (`activate-account`) et limitée en débit.
- **Mots de passe** : plus jamais recopiés dans la base lors d'un changement ; le mot de passe initial est effacé après le premier changement. Comptes désactivés : sessions révoquées + accès API refusé.
- **Injections (XSS / HTML)** : échappement systématique des données saisies par des tiers (profil public, avis, analytics, pages admin, emails).
- **Limitation de débit** (anti-spam / force brute) : capture de leads, formulaire de contact, suivi, activation, commandes publiques, demandes de devis, désabonnement.
- **En-têtes** (`vercel.json`) : CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy, COOP. CORS admin restreint aux domaines du site.
- **API** : erreurs génériques (plus de détails internes ni de données personnelles dans les journaux), entrées bornées, admin protégé par rôle.

## À faire de votre côté (non faisable depuis le code)
1. **Publier les règles Firestore** : `security/firestore.rules.recommended` → Firebase Console → Firestore → Règles. Tester d'abord avec le simulateur. C'est la protection la plus importante : tant que les anciennes règles sont actives, la base reste accessible directement depuis un navigateur.
2. **Variables Vercel** : `CRON_SECRET` (long, aléatoire), `RATE_LIMIT_SALT` (aléatoire), `SITE_URL`.
3. **TTL Firestore** sur `rateLimits.expireAt` (purge automatique).
4. **Révoquer** les jetons GitHub et le secret du cron qui ont été partagés dans des conversations, et en créer de nouveaux.
5. Activer **Firebase App Check** et la **protection contre les mots de passe fuités** (Auth → Paramètres) si disponibles.

## Limites connues
- La CSP autorise `'unsafe-inline'` pour les scripts (nombreux scripts et gestionnaires `onclick` en ligne) ; elle bloque en revanche les scripts, cadres, connexions et formulaires externes non listés.
- Aucune application web ne peut être garantie « totalement » sécurisée : ce document liste ce qui est couvert et ce qui reste à faire.
