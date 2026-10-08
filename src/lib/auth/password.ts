import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";

/** scrypt (N=2^15, r=8, p=1) con sal por usuario. */
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEYLEN, PARAMS).toString("hex");
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  if (!hash || !salt) return false;
  const attempt = scryptSync(password, salt, KEYLEN, PARAMS);
  const expected = Buffer.from(hash, "hex");
  return attempt.length === expected.length && timingSafeEqual(attempt, expected);
}

/** Reglas mínimas: 8+ caracteres, no todo igual, no igual al usuario. */
export function passwordProblem(password: string, username = ""): string | null {
  if (password.length < 8) return "La contraseña tiene que tener al menos 8 caracteres.";
  if (password.length > 200) return "La contraseña es demasiado larga.";
  if (/^(.)\1+$/.test(password)) return "Elegí una contraseña menos obvia.";
  if (username && password.toLowerCase() === username.toLowerCase()) return "La contraseña no puede ser igual al usuario.";
  return null;
}

/** Contraseña temporal fácil de dictar: sin 0/O/1/l. Ej. "kp7m-x4rd". */
export function temporaryPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const pick = () => alphabet[randomInt(alphabet.length)];
  const chunk = () => Array.from({ length: 4 }, pick).join("");
  return `${chunk()}-${chunk()}`;
}

/** Usuario: minúsculas, letras/números/punto/guion, 3–32. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function usernameProblem(username: string): string | null {
  if (!/^[a-z0-9._-]{3,32}$/.test(username))
    return "El usuario tiene que tener entre 3 y 32 caracteres: letras, números, punto o guion, sin espacios.";
  return null;
}
