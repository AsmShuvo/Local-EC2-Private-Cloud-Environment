// Envelope encryption for private keys at rest.
//
// AES-256-GCM (authenticated): tampering with the ciphertext is DETECTED at
// decrypt time rather than silently producing garbage — important, because a
// corrupted PEM would otherwise be handed to the user as a valid-looking file.
//
// The key is derived with scrypt from KEY_ENCRYPTION_SECRET. If that env var is
// missing we fall back to a local constant so the app still runs in dev, but we
// warn loudly: with the fallback, anyone with the database ALSO has the key.
const crypto = require("node:crypto");

const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce — the GCM standard
const SALT = "stratus-keypair-v1"; // fixed salt: one secret, one derived key

const FALLBACK = "stratus-dev-fallback-do-not-use-in-production";

let warned = false;
function secret() {
  const s = process.env.KEY_ENCRYPTION_SECRET;
  if (s && s.length >= 16) return s;
  if (!warned) {
    warned = true;
    console.warn(
      "[secretbox] KEY_ENCRYPTION_SECRET is not set — using an insecure dev fallback. " +
        "Private keys at rest are effectively unprotected. Set it in .env."
    );
  }
  return FALLBACK;
}

let cachedKey = null;
let cachedFor = null;
function derivedKey() {
  const s = secret();
  if (cachedKey && cachedFor === s) return cachedKey;
  cachedKey = crypto.scryptSync(s, SALT, 32);
  cachedFor = s;
  return cachedKey;
}

/** plaintext -> "iv.tag.ciphertext" (all base64) */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, derivedKey(), iv);
  const ct = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

/** "iv.tag.ciphertext" -> plaintext. Throws if tampered or the secret changed. */
function decrypt(payload) {
  const parts = String(payload || "").split(".");
  if (parts.length !== 3) {
    throw Object.assign(new Error("Malformed encrypted payload"), { status: 500 });
  }
  const [ivB64, tagB64, ctB64] = parts;
  try {
    const decipher = crypto.createDecipheriv(
      ALGO,
      derivedKey(),
      Buffer.from(ivB64, "base64")
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong secret, or the ciphertext was altered.
    throw Object.assign(
      new Error(
        "Could not decrypt the private key. The encryption secret may have changed since it was stored."
      ),
      { status: 500 }
    );
  }
}

module.exports = { encrypt, decrypt };
