import {
  addMembership,
  clearLoginFailures,
  countAccounts,
  createOrganization,
  createProvider,
  createUser,
  getAccount,
  getAccountByUsername,
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
  type OrgMember,
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
}): Promise<Result<{ userId: string; orgId: string }>> {
  const orgName = cleanName(v.orgName);
  const name = cleanName(v.name);
  const username = normalizeUsername(v.username ?? "");
  if (!orgName) return fail("Falta el nombre del consultorio.");
  if (!name) return fail("Falta tu nombre.");
  if (!ROLES.includes(v.role)) return fail("Elegí si sos médica/o o secretaría.");
  const up = usernameProblem(username) ?? passwordProblem(v.password ?? "", username);
  if (up) return fail(up);

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
    return fail(`Demasiados intentos. Probá de nuevo en ${min} min o pedile al admin que te resetee la contraseña.`, 429);
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
export async function listSellers(actor: Actor): Promise<Result<{ sellers: { providerId: string; name: string; aliases: string[] }[] }>> {
  if (!actor.activeOrg) return fail("No autorizado.", 403);
  const members = await listOrgMembers(actor.activeOrg.id);
  const sellers = members
    .filter((m) => m.active && m.role === "medico" && m.providerId)
    .filter((m) => actor.role !== "medico" || m.userId === actor.userId)
    .map((m) => ({ providerId: m.providerId!, name: m.name, aliases: m.aliases }));
  return { ok: true, sellers };
}

async function member(orgId: string, userId: string): Promise<OrgMember | undefined> {
  return (await listOrgMembers(orgId)).find((m) => m.userId === userId);
}

export async function createMember(
  actor: Actor,
  v: { name: string; username: string; role: StaffRole; isAdmin?: boolean; commissionPct?: number; aliases?: string | string[] },
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

  const temp = temporaryPassword();
  const user = await createUser({ name, username, role: v.role, password: hashPassword(temp), mustChangePassword: true });
  let providerId: string | undefined;
  if (v.role === "medico") {
    providerId = (await createProvider(g.orgId, name, "Médica/o")).id;
    await setProviderCommission(providerId, pct);
  }
  await addMembership({ userId: user.id, organizationId: g.orgId, role: v.role, providerId });
  if (v.isAdmin) await setOrgAdmin(g.orgId, user.id, true);
  const aliases = cleanAliases(v.aliases);
  if (aliases?.length) await setUserAliases(user.id, aliases);
  return { ok: true, userId: user.id, username, temporaryPassword: temp };
}

async function activeAdminCount(orgId: string): Promise<number> {
  return (await listOrgMembers(orgId)).filter((m) => m.active && m.isAdmin).length;
}

export async function updateMember(
  actor: Actor,
  userId: string,
  v: { name?: string; isAdmin?: boolean; commissionPct?: number; active?: boolean; aliases?: string | string[] },
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

  if (aliases !== undefined) await setUserAliases(userId, aliases);
  if (name !== undefined && name !== m.name) {
    await renameUser(userId, name);
    if (m.providerId) await renameProvider(m.providerId, name);
  }
  if (v.commissionPct !== undefined && m.providerId) await setProviderCommission(m.providerId, v.commissionPct);
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
