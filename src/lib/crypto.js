import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const SALT = "redpiston-field-v1";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getDerivedKey() {
  const raw = process.env.FIELD_ENCRYPTION_KEY;

  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("FIELD_ENCRYPTION_KEY must be set in production.");
    }
    // Dev fallback: fixed 32-byte buffer
    return scryptSync("dev-insecure-fallback-key-do-not-use", SALT, 32);
  }

  return scryptSync(raw, SALT, 32);
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * @param {string|null|undefined} plaintext
 * @returns {string|null} "ivHex:authTagHex:ciphertextHex" or null for null/empty input
 */
export function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === "") {
    return null;
  }

  const key = getDerivedKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts a ciphertext string produced by encrypt().
 * Returns the input unchanged if it is not in the expected "iv:tag:ciphertext" format (backward compat).
 * Returns null for null/empty input.
 * @param {string|null|undefined} ciphertext
 * @returns {string|null}
 */
export function decrypt(ciphertext) {
  if (ciphertext === null || ciphertext === undefined || ciphertext === "") {
    return null;
  }

  const parts = String(ciphertext).split(":");
  if (parts.length !== 3) {
    // Not in encrypted format — return as-is for backward compatibility
    return ciphertext;
  }

  const [ivHex, authTagHex, encryptedHex] = parts;

  // Validate hex lengths before attempting decode
  if (
    ivHex.length !== IV_LENGTH * 2 ||
    authTagHex.length !== AUTH_TAG_LENGTH * 2 ||
    encryptedHex.length === 0
  ) {
    return ciphertext;
  }

  try {
    const key = getDerivedKey();
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const encrypted = Buffer.from(encryptedHex, "hex");

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    // Auth tag mismatch or other decryption error — return input unchanged
    return ciphertext;
  }
}
