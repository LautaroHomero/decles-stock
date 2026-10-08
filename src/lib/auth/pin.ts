import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** Hash a 4-digit PIN with a per-user salt (scrypt). Demo-grade, not medical-grade. */
export function hashPin(pin: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pin, salt, 32).toString("hex");
  return { hash, salt };
}

export function verifyPin(pin: string, hash: string, salt: string): boolean {
  const attempt = scryptSync(pin, salt, 32);
  const expected = Buffer.from(hash, "hex");
  return attempt.length === expected.length && timingSafeEqual(attempt, expected);
}
