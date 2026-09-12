import crypto from "node:crypto";
import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 12;

export async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/** A random opaque token for links/codes handed to the user (email, cookie).
 * Only its SHA-256 hash is ever stored — matches the pattern already used
 * for ai_analysis.input_hash. */
export function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** A 6-digit numeric code for email 2FA — easy to type back, short-lived. */
export function generate2faCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export function isExpired(isoString) {
  return new Date(isoString).getTime() <= Date.now();
}
