import { createHmac, timingSafeEqual } from "node:crypto";
import type { Role } from "@/lib/domain/types";

// Distinto de Clavdia ("clinic_session"): las cookies no distinguen puerto y en local corren las dos apps.
export const SESSION_COOKIE = "decles_stock_session";
const MAX_AGE_SECONDS = 60 * 60 * 12; // 12h

/** What actually lives in the signed cookie — the full Actor is rehydrated per request. */
export interface SessionClaims {
  userId: string;
  role: Role;
  patientId?: string;
  /** For staff: the organization chosen at login. */
  activeOrgId?: string;
  /** users.session_version al loguearse: si cambia (baja, reset de contraseña), la sesión muere. */
  sv?: number;
}

const DEV_FALLBACK_SECRET = "dev-only-insecure-secret-change-me";
const IS_PROD = process.env.NODE_ENV === "production";

/**
 * HMAC key for the session cookie. In production it MUST be an explicit random
 * string of at least 32 chars: an unset (or too-short, or left-at-the-default)
 * secret lets anyone forge a session cookie and impersonate any role/org, so we
 * fail hard at boot instead of silently running on a known key.
 */
function secret(): string {
  const s = process.env.AUTH_SECRET;
  const usable = !!s && s.length >= 32 && s !== DEV_FALLBACK_SECRET;
  if (usable) return s;
  if (IS_PROD) {
    throw new Error(
      "AUTH_SECRET is required in production: set it to a random string of at least 32 characters " +
        "(e.g. `openssl rand -base64 48`).",
    );
  }
  return s || DEV_FALLBACK_SECRET;
}
const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

export function signSession(claims: SessionClaims): string {
  const body = b64url(JSON.stringify({ ...claims, iat: Date.now() }));
  const sig = b64url(createHmac("sha256", secret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySession(token: string | undefined | null): SessionClaims | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expected = b64url(createHmac("sha256", secret()).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionClaims & {
      iat: number;
    };
    if (!parsed.iat || Date.now() - parsed.iat > MAX_AGE_SECONDS * 1000) return null;
    return {
      userId: parsed.userId,
      role: parsed.role,
      patientId: parsed.patientId,
      activeOrgId: parsed.activeOrgId,
      sv: parsed.sv,
    };
  } catch {
    return null;
  }
}

export function claimsFromRequest(req: Request): SessionClaims | null {
  const cookie = req.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return verifySession(match?.[1] ? decodeURIComponent(match[1]) : null);
}

/**
 * `Secure` en producción con HTTPS (Vercel). Instalado en la PC del consultorio se entra
 * por http (localhost o la IP de la red): ahí COOKIE_SECURE=false, si no el navegador
 * descarta la cookie y nadie puede iniciar sesión.
 */
const SECURE = (process.env.COOKIE_SECURE ?? (IS_PROD ? "true" : "false")) === "true" ? "; Secure" : "";

export function sessionSetCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${SECURE}; Max-Age=${MAX_AGE_SECONDS}`;
}

export function sessionClearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${SECURE}; Max-Age=0`;
}
