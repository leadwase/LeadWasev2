# LeadWase — Cartes de visite connectées NFC

## Stack
- Frontend : HTML/CSS/JS vanilla multi-pages
- Backend  : Firebase Auth + Firestore + Cloud Functions
- Paiement : PaymentGateway lfdweb.com
- Hosting  : Firebase Hosting

## Installation
```bash
npm install -g firebase-tools
firebase login
firebase init   # Hosting + Firestore + Functions
cd functions && npm install
cd ..
firebase deploy
```

## Configuration
1. Remplir public/js/firebase-config.js avec vos clés Firebase
2. `firebase functions:config:set gateway.api_key="gw_..." site.url="https://leadwase.com"`
3. Configurer le webhook dans le dashboard PaymentGateway :
   URL : https://leadwase.com/api/webhook/payment
   Events : payment.completed, payment.failed
4. `firebase deploy`