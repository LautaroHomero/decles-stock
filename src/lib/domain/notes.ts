import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db/connection";
import { realNowIso } from "@/lib/domain/clock";
import type { Actor } from "@/lib/domain/types";

/**
 * Notas (Decles): lo que se quiere dejar escrito de una paciente. Se anotan desde la Planilla (pegadas a una
 * atención: `visitId`, con su día, práctica y profesional) o sueltas desde la pestaña Notas. Se buscan por
 * paciente o por lo escrito (sin importar tildes ni mayúsculas). Las escribe y lee todo el equipo; la corrige
 * o la borra quien la escribió o el admin.
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };
const fail = (error: string, status = 400) => ({ ok: false as const, error, status });
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export interface Note {
  id: string;
  patient: string;
  visitId: string | null;
  date: string;
  text: string;
  /** De la atención, si está pegada a una: qué se hizo y con quién. */
  visitWhat: string | null;
  visitProvider: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedByName: string | null;
}

type Row = Record<string, unknown>;

function ctx(actor: Actor) {
  const orgId = actor.activeOrg?.id;
  if (!orgId || actor.role === "paciente") return null;
  return { orgId, isAdmin: !!actor.activeOrg?.canAdmin };
}

const clean = (s: unknown) => (typeof s === "string" ? s.trim().replace(/[ \t]+/g, " ") : "");
// Para buscar sin tildes ni mayúsculas (lo mismo del lado de la base, con translate).
const FROM = "áéíóúüñàèìòùâêîôû";
const TO = "aeiouunaeiouaeiou";
const fold = (s: string) =>
  s
    .toLowerCase()
    .split("")
    .map((c) => (FROM.includes(c) ? TO[FROM.indexOf(c)] : c))
    .join("");

const toNote = (r: Row): Note => ({
  id: r.id as string,
  patient: r.patient_label as string,
  visitId: (r.visit_id as string | null) ?? null,
  date: r.date as string,
  text: r.text as string,
  visitWhat: (r.visit_what as string | null) || null,
  visitProvider: (r.visit_provider as string | null) || null,
  createdBy: r.created_by as string,
  createdByName: r.created_by_name as string,
  createdAt: r.created_at as string,
  updatedByName: (r.updated_by_name as string | null) ?? null,
});

async function raw(orgId: string, w: { q?: string; from?: string; to?: string; visitIds?: string[]; ids?: string[]; limit?: number }): Promise<Note[]> {
  const sql = getSql();
  // Cada palabra buscada tiene que estar en la paciente o en el texto.
  const words = w.q ? fold(w.q).split(/\s+/).filter(Boolean).slice(0, 6) : [];
  const hay = sql`translate(lower(n.patient_label || ' ' || n.text), ${FROM}, ${TO})`;
  const rows = (await sql`
    SELECT n.*,
      (SELECT string_agg(CASE WHEN s.quantity > 1 THEN s.quantity || ' ' || s.item_name ELSE s.item_name END, ', ' ORDER BY s.created_at)
         FROM sales s WHERE s.organization_id = n.organization_id AND s.visit_id = n.visit_id AND s.status = 'paid') AS visit_what,
      (SELECT pr.name FROM sales s JOIN providers pr ON pr.id = s.provider_id
         WHERE s.organization_id = n.organization_id AND s.visit_id = n.visit_id AND s.status = 'paid' LIMIT 1) AS visit_provider
    FROM notes n
    WHERE n.organization_id = ${orgId} AND n.status = 'active'
      ${w.from ? sql`AND n.date >= ${w.from}` : sql``}
      ${w.to ? sql`AND n.date <= ${w.to}` : sql``}
      ${w.visitIds ? sql`AND n.visit_id IN ${sql(w.visitIds.length ? w.visitIds : [""])}` : sql``}
      ${w.ids ? sql`AND n.id IN ${sql(w.ids)}` : sql``}
      ${words.length ? sql`AND ${words.map((x) => sql`${hay} LIKE ${`%${x}%`}`).reduce((a, b) => sql`${a} AND ${b}`)}` : sql``}
    ORDER BY n.date DESC, n.created_at DESC
    LIMIT ${w.limit ?? 300}`) as unknown as Row[];
  return rows.map(toNote);
}

/** Notas: `q` busca por paciente o texto; `from`/`to` (AAAA-MM-DD) acotan el día; `visitIds` = las de esas atenciones. */
export async function listNotes(actor: Actor, v: { q?: string | null; from?: string | null; to?: string | null; visitIds?: string[] | null }): Promise<Result<{ notes: Note[] }>> {
  const c = ctx(actor);
  if (!c) return { ok: true, notes: [] };
  if ((v.from && !YMD.test(v.from)) || (v.to && !YMD.test(v.to))) return fail("Fechas inválidas: usá AAAA-MM-DD.");
  return {
    ok: true,
    notes: await raw(c.orgId, {
      q: clean(v.q).slice(0, 120) || undefined,
      from: v.from || undefined,
      to: v.to || undefined,
      visitIds: v.visitIds ?? undefined,
      limit: v.visitIds ? 1000 : 300,
    }),
  };
}

export async function createNote(actor: Actor, v: { patient?: unknown; text?: unknown; visitId?: unknown; date?: unknown }): Promise<Result<{ note: Note }>> {
  const c = ctx(actor);
  if (!c) return fail("No autorizado.", 403);
  const text = clean(v.text).slice(0, 2000);
  if (!text) return fail("Escribí la nota.");
  let patient = clean(v.patient).slice(0, 120);
  const visitId = typeof v.visitId === "string" && v.visitId ? v.visitId : null;
  let date = typeof v.date === "string" && v.date ? v.date.slice(0, 10) : realNowIso().slice(0, 10);
  if (!YMD.test(date)) return fail("La fecha no es válida.");
  if (visitId) {
    // Pegada a una atención: el paciente y el día son los de esa atención.
    const [s] = (await getSql()`
      SELECT patient_label, created_at FROM sales WHERE organization_id = ${c.orgId} AND visit_id = ${visitId} AND status = 'paid' ORDER BY created_at LIMIT 1`) as unknown as Row[];
    if (!s) return fail("Esa atención ya no está.", 404);
    patient ||= (s.patient_label as string) ?? "";
    date = (s.created_at as string).slice(0, 10);
  }
  if (!patient) return fail("¿De qué paciente es la nota?");
  const id = `not_${randomUUID().slice(0, 8)}`;
  await getSql()`
    INSERT INTO notes (id, organization_id, patient_label, visit_id, date, text, created_by, created_by_name, created_at)
    VALUES (${id}, ${c.orgId}, ${patient}, ${visitId}, ${date}, ${text}, ${actor.userId}, ${actor.name}, ${realNowIso()})`;
  return { ok: true, note: (await raw(c.orgId, { ids: [id] }))[0] };
}

async function mine(actor: Actor, id: string) {
  const c = ctx(actor);
  if (!c) return fail("No autorizado.", 403);
  const [n] = await raw(c.orgId, { ids: [id] });
  if (!n) return fail("Esa nota ya no está.", 404);
  if (n.createdBy !== actor.userId && !c.isAdmin) return fail("La corrige quien la escribió o el admin.", 403);
  return { ok: true as const, orgId: c.orgId };
}

export async function updateNote(actor: Actor, id: string, v: { text?: unknown; patient?: unknown }): Promise<Result<{ note: Note }>> {
  const m = await mine(actor, id);
  if (!m.ok) return m;
  const text = clean(v.text).slice(0, 2000);
  if (!text) return fail("Escribí la nota (o borrala).");
  const patient = clean(v.patient).slice(0, 120);
  await getSql()`
    UPDATE notes SET text = ${text}, patient_label = COALESCE(NULLIF(${patient}, ''), patient_label),
      updated_at = ${realNowIso()}, updated_by_name = ${actor.name}
    WHERE id = ${id} AND organization_id = ${m.orgId}`;
  return { ok: true, note: (await raw(m.orgId, { ids: [id] }))[0] };
}

export async function deleteNote(actor: Actor, id: string): Promise<Result<object>> {
  const m = await mine(actor, id);
  if (!m.ok) return m;
  await getSql()`UPDATE notes SET status = 'voided', updated_at = ${realNowIso()}, updated_by_name = ${actor.name} WHERE id = ${id} AND organization_id = ${m.orgId}`;
  return { ok: true };
}
