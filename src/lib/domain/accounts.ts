import {
  addMembership,
  clearLoginFailures,
  countAccounts,
  createOrganization,
  createProvider,
  createUser,
  bumpResetAttempts,
  consumeResetCodes,
  emailTaken,
  getAccount,
  getAccountByEmail,
  getAccountByUsername,
  insertResetCode,
  latestResetCode,
  resetCodesSince,
  getOrganization,
  listOrgMembers,
  membershipsForUser,
  nameTaken,
  recordLoginFailure,
  renameProvider,
  renameUser,
  setOrgAdmin,
  setPassword,
  setProviderActive,
  setProviderCommission,
  setUserActive,
  setUserAliases,
  setUserEmail,
  type Account,
  type OrgMember,
  setProviderArea,
  PROVIDER_AREAS,
  type ProviderArea,
} from "@/lib/db/repo";
import { getSql } from "@/lib/db/connection";
import {
  hashPassword,
  normalizeUsername,
  passwordProblem,
  temporaryPassword,
  usernameProblem,
  verifyPassword,
} from "@/lib/auth/password";
import type { Actor, StaffRole } from "@/lib/domain/types";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mailMode, sendMail } from "@/lib/mail";

/**
 * Cuentas del consultorio: primer arranque, login, cambio de contraseña y el equipo
 * (alta, baja, reset, % de comisión). Toda la autorización vive acá.
 *
 * Reglas:
 *  · Solo un admin gestiona el equipo. No puede darse de baja ni quitarse el admin a sí
 *    mismo, y siempre tiene que quedar al menos un admin activo.
 *  · Nadie ve contraseñas: el admin entrega una temporal y la persona la cambia al entrar.
 *  · Baja = lógica (users.active = false): el historial de ventas conserva el nombre.
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };
const fail = (error: string, status = 400): { ok: false; error: string; status: number } => ({ ok: false, error, status });

export type { OrgMember };

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const ROLES: StaffRole[] = ["medico", "recepcion"];
const cleanName = (s: unknown) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "");

/** "Pili, pilu ,  lola" → ["pili","pilu","lola"]: minúsculas, sin tildes, 3+ letras, hasta 10. */
function cleanAliases(raw: unknown): string[] | null {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const out = [
    ...new Set(
      list
        .map((a) => String(a).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9ñ ]/g, "").trim())
        .filter((a) => a.length >= 3),
    ),
  ];
  return out.length > 10 ? null : out;
}

function pctProblem(pct: unknown): string | null {
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) return "La comisión tiene que ser un % entre 0 y 100.";
  if (Math.round(pct * 100) !== pct * 100) return "La comisión admite hasta 2 decimales.";
  return null;
}

/** Email opcional: '' = sin cargar. `null` = inválido. */
function cleanEmail(raw: unknown): string | null {
  const e = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!e) return "";
  return e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

async function emailProblem(raw: unknown, exceptUserId?: string): Promise<{ email: string } | { error: string }> {
  const email = cleanEmail(raw);
  if (email === null) return { error: "El email no parece válido." };
  if (await emailTaken(email, exceptUserId)) return { error: "Ese email ya lo usa otra persona del sistema." };
  return { email };
}

// ---------------------------------------------------------------------------
// Primer arranque
// ---------------------------------------------------------------------------

export async function needsSetup(): Promise<boolean> {
  return (await countAccounts()) === 0;
}

/** Crea el consultorio y su primer admin. Solo funciona con la base vacía. */
export async function setupFirstRun(v: {
  orgName: string;
  name: string;
  username: string;
  password: string;
  role: StaffRole;
  commissionPct?: number;
  email?: string;
}): Promise<Result<{ userId: string; orgId: string }>> {
  const orgName = cleanName(v.orgName);
  const name = cleanName(v.name);
  const username = normalizeUsername(v.username ?? "");
  if (!orgName) return fail("Falta el nombre del consultorio.");
  if (!name) return fail("Falta tu nombre.");
  if (!ROLES.includes(v.role)) return fail("Elegí si sos médica/o o secretaría.");
  const up = usernameProblem(username) ?? passwordProblem(v.password ?? "", username);
  if (up) return fail(up);
  const em = cleanEmail(v.email);
  if (em === null) return fail("El email no parece válido.");
  if (!em) return fail("Falta tu email: es para recuperar la contraseña si te la olvidás.");

  // Lock de la transacción: dos "primer arranque" simultáneos no pueden crear dos admins.
  return getSql().begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(4242)`;
    const [{ n }] = (await tx`SELECT count(*)::int AS n FROM users WHERE username <> ''`) as unknown as { n: number }[];
    if (n > 0) return fail("El sistema ya está configurado. Iniciá sesión.", 409);
    const org = await createOrganization({ name: orgName });
    const user = await createUser({ name, username, role: v.role, password: hashPassword(v.password), mustChangePassword: false });
    const providerId = v.role === "medico" ? (await createProvider(org.id, name, "Médica/o")).id : undefined;
    if (providerId && v.commissionPct) await setProviderCommission(providerId, v.commissionPct);
    await addMembership({ userId: user.id, organizationId: org.id, role: v.role, providerId });
    await setOrgAdmin(org.id, user.id, true);
    await setUserEmail(user.id, em);
    return { ok: true as const, userId: user.id, orgId: org.id };
  });
}

// ---------------------------------------------------------------------------
// Login y contraseña propia
// ---------------------------------------------------------------------------

/** Mismo mensaje para "no existe" y "contraseña mal": no se puede adivinar quién tiene cuenta. */
const BAD_LOGIN = "Usuario o contraseña incorrectos.";

export async function login(
  rawUsername: string,
  password: string,
): Promise<Result<{ userId: string; orgId: string; role: StaffRole; sv: number }>> {
  const username = normalizeUsername(rawUsername ?? "");
  if (!username || !password) return fail("Ingresá tu usuario y tu contraseña.");
  const acc = await getAccountByUsername(username);
  if (!acc) {
    hashPassword(password); // mismo costo de tiempo que un usuario real
    return fail(BAD_LOGIN, 401);
  }
  const now = new Date();
  if (acc.lockedUntil && new Date(acc.lockedUntil) > now) {
    const min = Math.ceil((new Date(acc.lockedUntil).getTime() - now.getTime()) / 60_000);
    return fail(`Demasiados intentos. Probá de nuevo en ${min} min o tocá «¿Te olvidaste la contraseña?».`, 429);
  }
  if (!verifyPassword(password, acc.passwordHash, acc.passwordSalt)) {
    await recordLoginFailure(acc.id, MAX_ATTEMPTS, new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString());
    return fail(BAD_LOGIN, 401);
  }
  if (!acc.active) return fail("Tu usuario está dado de baja. Hablá con el admin.", 403);
  const mems = await membershipsForUser(acc.id);
  if (!mems.length) return fail("Tu usuario no está en ningún consultorio.", 403);
  await clearLoginFailures(acc.id);
  return { ok: true, userId: acc.id, orgId: mems[0].organizationId, role: mems[0].role, sv: acc.sessionVersion };
}

/** La persona cambia su contraseña (obligatorio si entró con una temporal). */
export async function changeOwnPassword(actor: Actor, current: string, next: string): Promise<Result<object>> {
  const acc = await getAccount(actor.userId);
  if (!acc) return fail("No autenticado.", 401);
  if (!verifyPassword(current ?? "", acc.passwordHash, acc.passwordSalt)) return fail("La contraseña actual no es correcta.");
  const p = passwordProblem(next ?? "", acc.username);
  if (p) return fail(p);
  if (next === current) return fail("La nueva tiene que ser distinta de la actual.");
  // No se suben las sesiones: la actual sigue viva con la nueva contraseña.
  await setPassword(acc.id, hashPassword(next), { mustChange: false, bumpSessions: false });
  return { ok: true };
}

/** Cada persona carga (o borra) su propio email para recuperar la contraseña. */
export async function setOwnEmail(actor: Actor, raw: string): Promise<Result<{ email: string }>> {
  const em = await emailProblem(raw, actor.userId);
  if ("error" in em) return fail(em.error);
  await setUserEmail(actor.userId, em.email);
  return { ok: true, email: em.email };
}

export async function ownEmail(actor: Actor): Promise<string> {
  return (await getAccount(actor.userId))?.email ?? "";
}

// ---------------------------------------------------------------------------
// "¿Te olvidaste la contraseña?" — código de 6 dígitos por email
// ---------------------------------------------------------------------------
//
//  · La respuesta a "mandame el código" es siempre la misma: no revela quién tiene cuenta ni email.
//  · Vale solo el último código, 15 min, 5 intentos. Hasta 5 códigos por hora y 1 por minuto.
//  · Al usarlo: contraseña nueva, se cierran las demás sesiones y se desbloquea la cuenta.

const CODE_MINUTES = 15;
const CODE_ATTEMPTS = 5;
const CODES_PER_HOUR = 5;
const RESEND_SECONDS = 60;
const BAD_CODE = "El código no es correcto o ya venció. Revisalo o pedí uno nuevo.";

const hashCode = (code: string, salt: string) => createHash("sha256").update(`${salt}:${code}`).digest("hex");

export function recoveryEnabled(): boolean {
  return mailMode() !== "off";
}

async function findForRecovery(identifier: string): Promise<Account | undefined> {
  const id = (identifier ?? "").trim().toLowerCase();
  if (!id) return undefined;
  return id.includes("@") ? getAccountByEmail(id) : getAccountByUsername(normalizeUsername(id));
}

export async function requestPasswordReset(identifier: string): Promise<Result<object>> {
  if (!recoveryEnabled()) return fail("La recuperación por email no está activada. Pedile al admin que te resetee la contraseña.", 503);
  if (!(identifier ?? "").trim()) return fail("Escribí tu usuario o tu email.");
  const acc = await findForRecovery(identifier);
  if (!acc || !acc.active || !acc.email || !(await membershipsForUser(acc.id)).length) return { ok: true };

  const now = new Date();
  const recent = await resetCodesSince(acc.id, new Date(now.getTime() - 3600_000).toISOString());
  if (recent.n >= CODES_PER_HOUR) return { ok: true };
  if (recent.last && now.getTime() - new Date(recent.last).getTime() < RESEND_SECONDS * 1000) return { ok: true };

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const salt = randomBytes(16).toString("hex");
  await consumeResetCodes(acc.id, now.toISOString());
  await insertResetCode({
    userId: acc.id,
    hash: hashCode(code, salt),
    salt,
    sentTo: acc.email,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CODE_MINUTES * 60_000).toISOString(),
  });
  const sent = await sendMail({
    to: acc.email,
    subject: `Tu código: ${code}`,
    text:
      `Hola, ${acc.name.split(" ")[0]}.\n\n` +
      `Tu código para elegir una contraseña nueva es:\n\n    ${code}\n\n` +
      `Vence en ${CODE_MINUTES} minutos. Tu usuario es: ${acc.username}\n\n` +
      `Si no lo pediste vos, ignorá este mail: tu contraseña no cambia.\n`,
  });
  if (!sent) return fail("No se pudo mandar el mail. Probá de nuevo en un rato o pedile al admin que te resetee la contraseña.", 502);
  return { ok: true };
}

export async function confirmPasswordReset(
  identifier: string,
  code: string,
  password: string,
): Promise<Result<{ userId: string; orgId: string; role: StaffRole; sv: number }>> {
  const acc = await findForRecovery(identifier);
  const p = passwordProblem(password ?? "", acc?.username ?? "");
  if (p) return fail(p);
  const clean = (code ?? "").replace(/\D/g, "");
  if (!acc || !acc.active || clean.length !== 6) return fail(BAD_CODE);

  const nowIso = new Date().toISOString();
  const rc = await latestResetCode(acc.id, nowIso);
  if (!rc) return fail(BAD_CODE);
  if (rc.attempts >= CODE_ATTEMPTS) return fail("Demasiados intentos con ese código. Pedí uno nuevo.", 429);
  const a = Buffer.from(hashCode(clean, rc.codeSalt), "hex");
  const b = Buffer.from(rc.codeHash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    await bumpResetAttempts(rc.id);
    return fail(BAD_CODE);
  }

  await consumeResetCodes(acc.id, nowIso);
  await setPassword(acc.id, hashPassword(password), { mustChange: false, bumpSessions: true });
  const mems = await membershipsForUser(acc.id);
  if (!mems.length) return fail("Tu usuario no está en ningún consultorio.", 403);
  return { ok: true, userId: acc.id, orgId: mems[0].organizationId, role: mems[0].role, sv: acc.sessionVersion + 1 };
}

// ---------------------------------------------------------------------------
// Equipo (solo admin)
// ---------------------------------------------------------------------------

function adminOrg(actor: Actor): Result<{ orgId: string }> {
  if (!actor.activeOrg?.canAdmin) return fail("Solo un administrador puede gestionar el equipo.", 403);
  return { ok: true, orgId: actor.activeOrg.id };
}

export async function listTeam(actor: Actor): Promise<Result<{ members: OrgMember[] }>> {
  const g = adminOrg(actor);
  if (!g.ok) return g;
  return { ok: true, members: await listOrgMembers(g.orgId) };
}

/** Médicas activas del consultorio (para elegir quién vendió). La médica se ve solo a sí misma. */
export async function listSellers(
  actor: Actor,
): Promise<Result<{ sellers: { providerId: string; name: string; aliases: string[]; area: ProviderArea; commissionPct: number; owner: boolean }[] }>> {
  if (!actor.activeOrg) return fail("No autorizado.", 403);
  const members = await listOrgMembers(actor.activeOrg.id);
  const sellers = members
    .filter((m) => m.active && m.role === "medico" && m.providerId)
    .filter((m) => actor.role !== "medico" || m.userId === actor.userId)
    // La dueña (médica admin) no cobra comisión: todo lo suyo es del consultorio.
    .map((m) => ({ providerId: m.providerId!, name: m.name, aliases: m.aliases, area: m.area, commissionPct: m.isAdmin ? 0 : m.commissionPct, owner: m.isAdmin }));
  return { ok: true, sellers };
}

const isArea = (a: unknown): a is ProviderArea => typeof a === "string" && (PROVIDER_AREAS as readonly string[]).includes(a);

async function member(orgId: string, userId: string): Promise<OrgMember | undefined> {
  return (await listOrgMembers(orgId)).find((m) => m.userId === userId);
}

export async function createMember(
  actor: Actor,
  v: { name: string; username: string; role: StaffRole; isAdmin?: boolean; commissionPct?: number; aliases?: string | string[]; email?: string; area?: string },
): Promise<Result<{ userId: string; username: string; temporaryPassword: string }>> {
  const g = adminOrg(actor);
  if (!g.ok) return g;
  const name = cleanName(v.name);
  const username = normalizeUsername(v.username ?? "");
  if (!name) return fail("Falta el nombre.");
  if (!ROLES.includes(v.role)) return fail("El rol tiene que ser médica/o o secretaría.");
  const up = usernameProblem(username);
  if (up) return fail(up);
  if (await getAccountByUsername(username)) return fail(`El usuario "${username}" ya existe.`, 409);
  if (await nameTaken(name)) return fail(`Ya hay alguien llamado "${name}". Agregale el apellido o una inicial.`, 409);
  const pct = v.role === "medico" ? (v.commissionPct ?? 0) : 0;
  const pp = pctProblem(pct);
  if (pp) return fail(pp);
  const em = await emailProblem(v.email);
  if ("error" in em) return fail(em.error);

  const temp = temporaryPassword();
  const user = await createUser({ name, username, role: v.role, password: hashPassword(temp), mustChangePassword: true });
  let providerId: string | undefined;
  if (v.role === "medico") {
    providerId = (await createProvider(g.orgId, name, "Médica/o")).id;
    await setProviderCommission(providerId, pct);
    if (isArea(v.area)) await setProviderArea(providerId, v.area);
  }
  await addMembership({ userId: user.id, organizationId: g.orgId, role: v.role, providerId });
  if (v.isAdmin) await setOrgAdmin(g.orgId, user.id, true);
  const aliases = cleanAliases(v.aliases);
  if (aliases?.length) await setUserAliases(user.id, aliases);
  if (em.email) await setUserEmail(user.id, em.email);
  return { ok: true, userId: user.id, username, temporaryPassword: temp };
}

async function activeAdminCount(orgId: string): Promise<number> {
  return (await listOrgMembers(orgId)).filter((m) => m.active && m.isAdmin).length;
}

export async function updateMember(
  actor: Actor,
  userId: string,
  v: { name?: string; isAdmin?: boolean; commissionPct?: number; active?: boolean; aliases?: string | string[]; email?: string; area?: string },
): Promise<Result<object>> {
  const g = adminOrg(actor);
  if (!g.ok) return g;
  const m = await member(g.orgId, userId);
  if (!m) return fail("No encontré a esa persona en el consultorio.", 404);
  const self = userId === actor.userId;

  if (v.active === false && m.active) {
    if (self) return fail("No podés darte de baja a vos mismo.");
    if (m.isAdmin && (await activeAdminCount(g.orgId)) <= 1) return fail("Tiene que quedar al menos un admin activo.");
  }
  if (v.isAdmin === false && m.isAdmin) {
    if (self) return fail("No podés quitarte el admin a vos mismo: pedíselo a otro admin.");
    if (m.active && (await activeAdminCount(g.orgId)) <= 1) return fail("Tiene que quedar al menos un admin activo.");
  }
  if (v.commissionPct !== undefined) {
    if (m.role !== "medico" || !m.providerId) return fail("La comisión es solo para médicas/os.");
    const pp = pctProblem(v.commissionPct);
    if (pp) return fail(pp);
  }
  const name = v.name === undefined ? undefined : cleanName(v.name);
  if (name !== undefined) {
    if (!name) return fail("Falta el nombre.");
    if (await nameTaken(name, userId)) return fail(`Ya hay alguien llamado "${name}".`, 409);
  }

  const aliases = v.aliases === undefined ? undefined : cleanAliases(v.aliases);
  if (aliases === null) return fail("Hasta 10 apodos.");
  const em = v.email === undefined ? undefined : await emailProblem(v.email, userId);
  if (em && "error" in em) return fail(em.error);

  if (aliases !== undefined) await setUserAliases(userId, aliases);
  if (em && em.email !== m.email) await setUserEmail(userId, em.email);
  if (name !== undefined && name !== m.name) {
    await renameUser(userId, name);
    if (m.providerId) await renameProvider(m.providerId, name);
  }
  if (v.commissionPct !== undefined && m.providerId) await setProviderCommission(m.providerId, v.commissionPct);
  if (v.area !== undefined) {
    if (!m.providerId || !isArea(v.area)) return fail("Área inválida.");
    await setProviderArea(m.providerId, v.area);
  }
  if (v.isAdmin !== undefined && v.isAdmin !== m.isAdmin) await setOrgAdmin(g.orgId, userId, v.isAdmin);
  if (v.active !== undefined && v.active !== m.active) {
    await setUserActive(userId, v.active);
    if (m.providerId) await setProviderActive(m.providerId, v.active);
  }
  return { ok: true };
}

/** Contraseña temporal nueva; cierra sus sesiones y desbloquea la cuenta. */
export async function resetMemberPassword(actor: Actor, userId: string): Promise<Result<{ username: string; temporaryPassword: string }>> {
  const g = adminOrg(actor);
  if (!g.ok) return g;
  const m = await member(g.orgId, userId);
  if (!m) return fail("No encontré a esa persona en el consultorio.", 404);
  if (!m.active) return fail("Está dada de baja: reactivala primero.");
  const temp = temporaryPassword();
  await setPassword(userId, hashPassword(temp), { mustChange: true, bumpSessions: true });
  return { ok: true, username: m.username, temporaryPassword: temp };
}

/** Para la consola (`npm run user:reset-password`) si el único admin perdió su contraseña. */
export async function resetPasswordByUsername(username: string): Promise<Result<{ name: string; temporaryPassword: string }>> {
  const acc = await getAccountByUsername(normalizeUsername(username));
  if (!acc) return fail(`No existe el usuario "${username}".`, 404);
  const temp = temporaryPassword();
  await setPassword(acc.id, hashPassword(temp), { mustChange: true, bumpSessions: true });
  if (!acc.active) await setUserActive(acc.id, true);
  return { ok: true, name: acc.name, temporaryPassword: temp };
}

export async function organizationName(orgId: string): Promise<string> {
  return (await getOrganization(orgId))?.name ?? "";
}
