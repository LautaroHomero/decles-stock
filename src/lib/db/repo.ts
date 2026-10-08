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
// Users, memberships
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

type UserWithPin = User & { pinHash: string; pinSalt: string };
const withPin = (r: Row): UserWithPin => ({ ...toUser(r), pinHash: r.pin_hash as string, pinSalt: r.pin_salt as string });

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
  email: string;
  role: StaffRole;
  isAdmin: boolean;
}

export async function listOrgMembers(orgId: string): Promise<OrgMember[]> {
  const org = await getOrganization(orgId);
  const adminIds = new Set(org?.adminIds ?? []);
  const rows = (await getSql()`
    SELECT u.id AS user_id, u.name, u.email, m.role
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ${orgId}
    ORDER BY u.name`) as unknown as Row[];
  return rows.map((r) => ({
    userId: r.user_id as string,
    name: r.name as string,
    email: (r.email as string) ?? "",
    role: r.role as StaffRole,
    isAdmin: adminIds.has(r.user_id as string),
  }));
}

/** En esta app no hay pacientes con login; se mantiene la firma de Clavdia. */
export async function patientOrgs(patientId: string): Promise<OrgRef[]> {
  void patientId;
  return [];
}

export const normEmail = (s: string): string => s.trim().toLowerCase();
const bareDni = (s: string) => s.replace(/\D/g, "");

export async function getUser(id: string): Promise<User | undefined> {
  const [r] = (await getSql()`SELECT * FROM users WHERE id = ${id}`) as unknown as Row[];
  return r ? toUser(r) : undefined;
}

export async function getUserByEmail(email: string): Promise<UserWithPin | undefined> {
  const target = normEmail(email);
  if (!target) return undefined;
  const [r] = (await getSql()`SELECT * FROM users WHERE lower(trim(email)) = ${target}`) as unknown as Row[];
  return r ? withPin(r) : undefined;
}

export async function getUserByDni(dni: string): Promise<UserWithPin | undefined> {
  const target = bareDni(dni);
  if (!target) return undefined;
  const rows = (await getSql()`SELECT * FROM users WHERE trim(dni) <> ''`) as unknown as Row[];
  const r = rows.find((row) => bareDni(row.dni as string) === target);
  return r ? withPin(r) : undefined;
}

export async function createUser(args: {
  name: string;
  email: string;
  role: Role;
  pinHash: string;
  pinSalt: string;
  dni?: string;
  phone?: string;
}): Promise<User> {
  const id = uid("u");
  const email = normEmail(args.email);
  const dni = (args.dni ?? "").trim();
  const phone = (args.phone ?? "").trim();
  await getSql()`
    INSERT INTO users (id, name, email, dni, phone, role, pin_hash, pin_salt)
    VALUES (${id}, ${args.name.trim()}, ${email}, ${dni}, ${phone}, ${args.role}, ${args.pinHash}, ${args.pinSalt})`;
  return { id, name: args.name.trim(), email, dni, phone, role: args.role };
}

export async function updateUserPin(userId: string, pin: { hash: string; salt: string }): Promise<void> {
  await getSql()`UPDATE users SET pin_hash = ${pin.hash}, pin_salt = ${pin.salt} WHERE id = ${userId}`;
}

/** Resolve a login from an email or a DNI. */
export async function findLogin(args: { email?: string; dni?: string }): Promise<User | undefined> {
  const raw = (args.email ?? args.dni ?? "").trim();
  if (!raw) return undefined;
  const hit = raw.includes("@") ? await getUserByEmail(raw) : await getUserByDni(raw);
  if (!hit) return undefined;
  return { id: hit.id, name: hit.name, email: hit.email, dni: hit.dni, phone: hit.phone, role: hit.role };
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

export async function getPatient(id: string): Promise<Patient | undefined> {
  const [r] = (await getSql()`SELECT * FROM patients WHERE id = ${id}`) as unknown as Row[];
  return r
    ? { id: r.id as string, fullName: r.full_name as string, dni: r.dni as string, phone: r.phone as string, email: r.email as string }
    : undefined;
}

// ---------------------------------------------------------------------------
// One-time PIN-recovery codes
// ---------------------------------------------------------------------------

export type PinResetCode = {
  id: string;
  userId: string;
  codeHash: string;
  codeSalt: string;
  channel: string;
  sentTo: string;
  attempts: number;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
};

const toPinResetCode = (r: Row): PinResetCode => ({
  id: r.id as string,
  userId: r.user_id as string,
  codeHash: r.code_hash as string,
  codeSalt: r.code_salt as string,
  channel: r.channel as string,
  sentTo: r.sent_to as string,
  attempts: Number(r.attempts),
  createdAt: r.created_at as string,
  expiresAt: r.expires_at as string,
  consumedAt: (r.consumed_at as string) ?? null,
});

export async function createPinResetCode(args: {
  userId: string;
  codeHash: string;
  codeSalt: string;
  channel: string;
  sentTo: string;
  ttlMinutes: number;
}): Promise<PinResetCode> {
  const sql = getSql();
  const now = new Date();
  await sql`UPDATE pin_reset_codes SET consumed_at = ${now.toISOString()} WHERE user_id = ${args.userId} AND consumed_at IS NULL`;
  const id = uid("prc");
  const expires = new Date(now.getTime() + args.ttlMinutes * 60_000);
  await sql`
    INSERT INTO pin_reset_codes (id, user_id, code_hash, code_salt, channel, sent_to, attempts, created_at, expires_at)
    VALUES (${id}, ${args.userId}, ${args.codeHash}, ${args.codeSalt}, ${args.channel}, ${args.sentTo}, 0, ${now.toISOString()}, ${expires.toISOString()})`;
  const [r] = (await sql`SELECT * FROM pin_reset_codes WHERE id = ${id}`) as unknown as Row[];
  return toPinResetCode(r);
}

export async function activePinResetCode(userId: string): Promise<PinResetCode | undefined> {
  const [r] = (await getSql()`
    SELECT * FROM pin_reset_codes
    WHERE user_id = ${userId} AND consumed_at IS NULL AND expires_at > ${new Date().toISOString()}
    ORDER BY created_at DESC LIMIT 1`) as unknown as Row[];
  return r ? toPinResetCode(r) : undefined;
}

export async function bumpPinResetAttempts(id: string): Promise<number> {
  const [r] = (await getSql()`
    UPDATE pin_reset_codes SET attempts = attempts + 1 WHERE id = ${id} RETURNING attempts`) as unknown as Row[];
  return Number(r?.attempts ?? 0);
}

export async function consumePinResetCode(id: string): Promise<void> {
  await getSql()`UPDATE pin_reset_codes SET consumed_at = ${new Date().toISOString()} WHERE id = ${id}`;
}
