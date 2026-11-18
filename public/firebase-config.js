/* MyChat Firebase Web Push configuration.
 * REQUIRED: Copy the exact values from Firebase Console → Project settings → Your apps → Web app.
 * Steps to get credentials:
 * 1. Go to Firebase Console: https://console.firebase.google.com
 * 2. Select project 'mychat-fdd41' (or your actual project)
 * 3. Click "Project Settings" (gear icon) → "Your apps" tab
 * 4. Find your Web app and copy ENTIRE config object
 * 5. Copy Web API Key from Settings → API Keys
 * 6. For VAPID key: Go to Cloud Messaging tab → Web push certificates → Create key pair
 * 
 * Do NOT put the service-account private key in this file - that stays in the local .env file
 */
self.__MYCHAT_FIREBASE__ = {
  firebaseConfig: {
    apiKey: 'AIzaSyC-3xBeM1R-PFWbfTJpcNXkpAS3BW0wrrQ',
    authDomain: 'mychat-fdd41.firebaseapp.com',
    projectId: 'mychat-fdd41',
    storageBucket: 'mychat-fdd41.firebasestorage.app',
    messagingSenderId: '815099639619',
    appId: '1:815099639619:web:d49fce9109f13efb93a1f6'
  },
  vapidKey: 'BBR6HmCw7EMN_nWFwMDRgOapSxKjFNcAsepu70jmKSYdR9lnfVpqwuZPMlkBKm0W6PvFPPkChi9LWQWMYcGraCs'
};
