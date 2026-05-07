import { config } from 'dotenv';
config({ override: true });
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

let firebaseInitialized = false;

function initFirebase() {
  if (firebaseInitialized || getApps().length > 0) return;

  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    firebaseInitialized = true;
    console.log('[Firebase] Admin SDK initialized');
  } else {
    console.log('[Firebase] Running in dev mode — Firebase credentials not set, token verification bypassed');
  }
}

// Verify a Firebase ID token and return decoded claims
export async function verifyFirebaseToken(idToken) {
  initFirebase();

  // Dev mode bypass: if no Firebase credentials, accept a dev token format
  // Dev token format: "dev:<phone>" or "dev-google:<email>"
  if (!firebaseInitialized) {
    if (idToken.startsWith('dev:')) {
      const phone = idToken.replace('dev:', '').trim();
      return { uid: `dev_${phone}`, phone_number: `+91${phone}`, provider: 'phone' };
    }
    if (idToken.startsWith('dev-google:')) {
      const email = idToken.replace('dev-google:', '').trim();
      return { uid: `dev_google_${email}`, email, name: 'Dev User', provider: 'google' };
    }
    throw new Error('DEV_MODE: Use "dev:<phone>" or "dev-google:<email>" as token in development');
  }

  const decoded = await getAuth().verifyIdToken(idToken);
  const provider = decoded.firebase?.sign_in_provider || 'phone';
  return {
    uid: decoded.uid,
    phone_number: decoded.phone_number,
    email: decoded.email,
    name: decoded.name,
    picture: decoded.picture,
    provider: provider === 'google.com' ? 'google' : 'phone',
  };
}
