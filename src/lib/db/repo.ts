import { randomUUID } from "node:crypto";
import type { OrgRef, Organization, Patient, Provider, Role, StaffRole, User } from "@/lib/domain/types";
import { getSql } from "./connection";

/**
 * Consultorios, usuarios, membresías y códigos de PIN. Recorte de
 * `src/lib/db/repo.ts` de Clavdia: mismas funciones y mismas queries, solo las
 * que usa el stock.
 */

type Row = Record<string, unknown>;
const uid = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;

function normName(s: string): string {
  return s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

const toOrg = (r: Row): Organization => ({
  id: r.id as string,
  name: r.name as string,
  slug: r.slug as string,
  address: r.address as string,
  city: (r.city as string) ?? "",
  hours: r.hours as string,
  phone: r.phone as string,
  whatsappFrom: (r.whatsapp_from as string) ?? "",
  adminIds: JSON.parse((r.admin_ids as string) || "[]"),
});

export async function listOrganizations(): Promise<Organization[]> {
  const rows = (await getSql()`SELECT * FROM organizations ORDER BY name`) as unknown as Row[];
  return rows.map(toOrg);
}

export async function getOrganization(id: string): Promise<Organization | undefined> {
  const [r] = (await getSql()`SELECT * FROM organizations WHERE id = ${id}`) as unknown as Row[];
  return r ? toOrg(r) : undefined;
}

export async function getOrganizationByName(name: string): Promise<Organization | undefined> {
  return (await listOrganizations()).find((o) => normName(o.name) === normName(name));
}

function slugify(s: string): string {
  return normName(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org";
}

export async function createOrganization(input: { name: string; address?: string; city?: string; phone?: string }): Promise<Organization> {
  const sql = getSql();
  let slug = slugify(input.name);
  const [taken] = (await sql`SELECT 1 FROM organizations WHERE slug = ${slug}`) as unknown as Row[];
  if (taken) slug = `${slug}-${uid("").slice(1, 5)}`;
  const id = uid("org");
  await sql`
    INSERT INTO organizations (id, name, slug, address, city, phone, created_at)
    VALUES (${id}, ${input.name.trim()}, ${slug}, ${input.address?.trim() ?? ""}, ${input.city?.trim() ?? ""},
            ${input.phone?.trim() ?? ""}, ${new Date().toISOString()})`;
  return (await getOrganization(id))!;
}

/** Da o quita admin del consultorio (no toca el rol médico/recepción). */
export async function setOrgAdmin(orgId: string, userId: string, isAdmin: boolean): Promise<void> {
  const org = await getOrganization(orgId);
  if (!org) return;
  const next = new Set(org.adminIds);
  if (isAdmin) next.add(userId);
  else next.delete(userId);
  await getSql()`UPDATE organizations SET admin_ids = ${JSON.stringify([...next])} WHERE id = ${orgId}`;
}

// ---------------------------------------------------------------------------
// Users, memberships, cuentas
// ---------------------------------------------------------------------------

const toUser = (r: Row): User => ({
  id: r.id as string,
  name: r.name as string,
  email: (r.email as string) ?? "",
  dni: (r.dni as string) ?? "",
  phone: (r.phone as string) ?? "",
  role: r.role as Role,
  patientId: (r.patient_id as string) ?? undefined,
});

/** Lo que hace falta para autenticar (nunca sale del servidor). */
export interface Account extends User {
  username: string;
  passwordHash: string;
  passwordSalt: string;
  mustChangePassword: boolean;
  active: boolean;
  sessionVersion: number;
  failedLogins: number;
  lockedUntil: string | null;
}

const toAccount = (r: Row): Account => ({
  ...toUser(r),
  username: (r.username as string) ?? "",
  passwordHash: (r.password_hash as string) ?? "",
  passwordSalt: (r.password_salt as string) ?? "",
  mustChangePassword: Boolean(r.must_change_password),
  active: Boolean(r.active),
  sessionVersion: Number(r.session_version ?? 0),
  failedLogins: Number(r.failed_logins ?? 0),
  lockedUntil: (r.locked_until as string) ?? null,
});

export interface Membership {
  organizationId: string;
  organizationName: string;
  role: StaffRole;
  providerId?: string;
  specialty?: string;
  canAdmin: boolean;
}

export async function membershipsForUser(userId: string): Promise<Membership[]> {
  const rows = (await getSql()`
    SELECT m.organization_id, o.name AS org_name, o.admin_ids, m.role, m.provider_id, p.specialty
    FROM memberships m
    JOIN organizations o ON o.id = m.organization_id
    LEFT JOIN providers p ON p.id = m.provider_id
    WHERE m.user_id = ${userId}
    ORDER BY o.name`) as unknown as Row[];
  return rows.map((r) => {
    const adminIds: string[] = JSON.parse((r.admin_ids as string) || "[]");
    return {
      organizationId: r.organization_id as string,
      organizationName: r.org_name as string,
      role: r.role as StaffRole,
      providerId: (r.provider_id as string) ?? undefined,
      specialty: (r.specialty as string) ?? undefined,
      canAdmin: adminIds.includes(userId),
    };
  });
}

export interface OrgMember {
  userId: string;
  name: string;
  username: string;
  role: StaffRole;
  isAdmin: boolean;
  active: boolean;
  mustChangePassword: boolean;
  providerId: string | null;
  commissionPct: number;
}

/** El equipo del consultorio (activos e inactivos), con admin y comisión. */
export async function listOrgMembers(orgId: string): Promise<OrgMember[]> {
  const org = await getOrganization(orgId);
  const adminIds = new Set(org?.adminIds ?? []);
  const rows = (await getSql()`
    SELECT u.id AS user_id, u.name, u.username, u.active, u.must_change_password, m.role, m.provider_id, p.commission_pct
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN providers p ON p.id = m.provider_id
    WHERE m.organization_id = ${orgId}
    ORDER BY u.active DESC, u.name`) as unknown as Row[];
  return rows.map((r) => ({
    userId: r.user_id as string,
    name: r.name as string,
    username: (r.username as string) ?? "",
    role: r.role as StaffRole,
    isAdmin: adminIds.has(r.user_id as string),
    active: Boolean(r.active),
    mustChangePassword: Boolean(r.must_change_password),
    providerId: (r.provider_id as string) ?? null,
    commissionPct: Number(r.commission_pct ?? 0),
  }));
}

/** En esta app no hay pacientes con login; se mantiene la firma de Clavdia. */
export async function patientOrgs(patientId: string): Promise<OrgRef[]> {
  void patientId;
  return [];
}

export async function getUser(id: string): Promise<User | undefined> {
  const [r] = (await getSql()`SELECT * FROM users WHERE id = ${id}`) as unknown as Row[];
  return r ? toUser(r) : undefined;
}

export async function getAccount(id: string): Promise<Account | undefined> {
  const [r] = (await getSql()`SELECT * FROM users WHERE id = ${id}`) as unknown as Row[];
  return r ? toAccount(r) : undefined;
}

export async function getAccountByUsername(username: string): Promise<Account | undefined> {
  const [r] = (await getSql()`SELECT * FROM users WHERE lower(username) = ${username.toLowerCase()} AND username <> ''`) as unknown as Row[];
  return r ? toAccount(r) : undefined;
}

export async function countAccounts(): Promise<number> {
  const [r] = (await getSql()`SELECT count(*)::int AS n FROM users WHERE username <> ''`) as unknown as Row[];
  return Number(r?.n ?? 0);
}

export async function createUser(args: {
  name: string;
  username: string;
  role: Role;
  password: { hash: string; salt: string };
  mustChangePassword: boolean;
}): Promise<User> {
  const id = uid("u");
  await getSql()`
    INSERT INTO users (id, name, email, role, pin_hash, pin_salt, username, password_hash, password_salt, must_change_password)
    VALUES (${id}, ${args.name.trim()}, '', ${args.role}, '', '', ${args.username}, ${args.password.hash}, ${args.password.salt}, ${args.mustChangePassword})`;
  return { id, name: args.name.trim(), email: "", dni: "", phone: "", role: args.role };
}

/** Nueva contraseña; `bumpSessions` cierra todas las sesiones abiertas de esa persona. */
export async function setPassword(
  userId: string,
  pw: { hash: string; salt: string },
  opts: { mustChange: boolean; bumpSessions: boolean },
): Promise<void> {
  await getSql()`
    UPDATE users SET password_hash = ${pw.hash}, password_salt = ${pw.salt},
      must_change_password = ${opts.mustChange}, failed_logins = 0, locked_until = NULL,
      session_version = session_version + ${opts.bumpSessions ? 1 : 0}
    WHERE id = ${userId}`;
}

export async function recordLoginFailure(userId: string, maxAttempts: number, lockedUntil: string): Promise<void> {
  await getSql()`
    UPDATE users SET failed_logins = failed_logins + 1,
      locked_until = CASE WHEN failed_logins + 1 >= ${maxAttempts} THEN ${lockedUntil} ELSE locked_until END
    WHERE id = ${userId}`;
}

export async function clearLoginFailures(userId: string): Promise<void> {
  await getSql()`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ${userId}`;
}

/** Baja / reactivación. La baja cierra sus sesiones. */
export async function setUserActive(userId: string, active: boolean): Promise<void> {
  await getSql()`
    UPDATE users SET active = ${active}, session_version = session_version + ${active ? 0 : 1}
    WHERE id = ${userId}`;
}

export async function renameUser(userId: string, name: string): Promise<void> {
  await getSql()`UPDATE users SET name = ${name.trim()} WHERE id = ${userId}`;
}

export async function nameTaken(name: string, exceptUserId?: string): Promise<boolean> {
  const [r] = (await getSql()`
    SELECT 1 FROM users WHERE lower(trim(name)) = ${name.trim().toLowerCase()} AND id <> ${exceptUserId ?? ""}`) as unknown as Row[];
  return !!r;
}

export async function addMembership(args: {
  userId: string;
  organizationId: string;
  role: StaffRole;
  providerId?: string;
}): Promise<void> {
  await getSql()`
    INSERT INTO memberships (user_id, organization_id, role, provider_id)
    VALUES (${args.userId}, ${args.organizationId}, ${args.role}, ${args.providerId ?? null})
    ON CONFLICT (user_id, organization_id)
    DO UPDATE SET role = EXCLUDED.role, provider_id = EXCLUDED.provider_id`;
}

// ---------------------------------------------------------------------------
// Providers / patients (solo lo que piden precios y ventas)
// ---------------------------------------------------------------------------

const toProvider = (r: Row): Provider => ({
  id: r.id as string,
  organizationId: r.organization_id as string,
  name: r.name as string,
  specialty: r.specialty as string,
  roomLabel: r.room_label as string,
  defaultFee: Number(r.default_fee ?? 0),
  active: Boolean(r.active ?? true),
  commissionPct: Number(r.commission_pct ?? 0),
});

export async function getProvider(id: string): Promise<Provider | undefined> {
  const [r] = (await getSql()`SELECT * FROM providers WHERE id = ${id}`) as unknown as Row[];
  return r ? toProvider(r) : undefined;
}

/** El médico como profesional del consultorio (en Clavdia, lo crea el alta de profesional). */
export async function createProvider(orgId: string, name: string, specialty: string): Promise<Provider> {
  const id = uid("prov");
  await getSql()`
    INSERT INTO providers (id, organization_id, name, specialty, room_label)
    VALUES (${id}, ${orgId}, ${name.trim()}, ${specialty.trim()}, '')`;
  return (await getProvider(id))!;
}

export async function setProviderCommission(providerId: string, pct: number): Promise<void> {
  await getSql()`UPDATE providers SET commission_pct = ${pct} WHERE id = ${providerId}`;
}

export async function setProviderActive(providerId: string, active: boolean): Promise<void> {
  await getSql()`UPDATE providers SET active = ${active ? 1 : 0} WHERE id = ${providerId}`;
}

export async function renameProvider(providerId: string, name: string): Promise<void> {
  await getSql()`UPDATE providers SET name = ${name.trim()} WHERE id = ${providerId}`;
}

export async function getPatient(id: string): Promise<Patient | undefined> {
  const [r] = (await getSql()`SELECT * FROM patients WHERE id = ${id}`) as unknown as Row[];
  return r
    ? { id: r.id as string, fullName: r.full_name as string, dni: r.dni as string, phone: r.phone as string, email: r.email as string }
    : undefined;
}
