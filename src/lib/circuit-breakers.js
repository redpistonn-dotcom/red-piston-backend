import CircuitBreaker from "opossum";

const DEFAULT_OPTIONS = {
  timeout: 5000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 5,
};

function attachListeners(breaker, name) {
  breaker.on("open", () =>
    console.warn(`[CircuitBreaker] ${name} circuit OPENED — calls will fail fast`)
  );
  breaker.on("halfOpen", () =>
    console.info(`[CircuitBreaker] ${name} circuit HALF-OPEN — probing with next call`)
  );
  breaker.on("close", () =>
    console.info(`[CircuitBreaker] ${name} circuit CLOSED — service recovered`)
  );
}

// Email breaker — wraps a function that accepts a Resend payload and sends the email
async function sendEmail(payload) {
  const { Resend } = await import("resend");
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data, error } = await resend.emails.send(payload);
  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);
  return data;
}

export const emailBreaker = new CircuitBreaker(sendEmail, {
  ...DEFAULT_OPTIONS,
  name: "email",
});
attachListeners(emailBreaker, "Email");

// Firebase breaker — wraps Firebase Admin token verification
async function verifyFirebaseToken(idToken) {
  const firebaseAdmin = await import("firebase-admin");
  const app =
    firebaseAdmin.apps?.length
      ? firebaseAdmin.app()
      : firebaseAdmin.initializeApp();
  return app.auth().verifyIdToken(idToken);
}

export const firebaseBreaker = new CircuitBreaker(verifyFirebaseToken, {
  ...DEFAULT_OPTIONS,
  name: "firebase",
});
attachListeners(firebaseBreaker, "Firebase");

// Cloudinary breaker — wraps a Cloudinary upload
async function uploadToCloudinary(uploadPayload) {
  const cloudinary = await import("cloudinary");
  const { file, options = {} } = uploadPayload;
  return cloudinary.v2.uploader.upload(file, options);
}

export const cloudinaryBreaker = new CircuitBreaker(uploadToCloudinary, {
  ...DEFAULT_OPTIONS,
  name: "cloudinary",
});
attachListeners(cloudinaryBreaker, "Cloudinary");

// Helpers for quick open-state checks
export function isEmailCircuitOpen() {
  return emailBreaker.opened;
}

export function isFirebaseCircuitOpen() {
  return firebaseBreaker.opened;
}
