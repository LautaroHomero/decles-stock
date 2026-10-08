// Subconjunto del modelo de dominio de Clavdia (src/lib/domain/types.ts allá):
// mismos nombres y formas, para que el código de stock pase sin cambios al integrar.

export type Role = "medico" | "recepcion" | "paciente";
export type StaffRole = "medico" | "recepcion";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  address: string;
  city: string;
  hours: string;
  phone: string;
  whatsappFrom: string;
  adminIds: string[];
}

export interface OrgRef {
  id: string;
  name: string;
}

/** A staff user's active organization for the session. */
export interface StaffOrg extends OrgRef {
  role: StaffRole;
  providerId?: string; // for medico
  specialty?: string;
  /** Admin del consultorio (organizations.admin_ids): carga stock, precios, anula ventas. */
  canAdmin: boolean;
}

export interface User {
  id: string;
  name: string;
  email: string;
  dni: string;
  phone: string;
  role: Role;
  patientId?: string;
}

/** Quién hace el pedido — se rehidrata desde la cookie de sesión en cada request. */
export interface Actor {
  userId: string;
  name: string;
  role: Role;
  patientId?: string;
  activeOrg?: StaffOrg;
  orgs: OrgRef[];
  /** Entró con una contraseña temporal: hasta cambiarla no puede hacer nada más. */
  mustChangePassword?: boolean;
}

export interface Provider {
  id: string;
  organizationId: string;
  name: string;
  specialty: string;
  roomLabel: string;
  defaultFee: number;
  active: boolean;
  /** % de comisión sobre las ventas de productos (Decles). */
  commissionPct: number;
}

export interface Patient {
  id: string;
  fullName: string;
  dni: string;
  phone: string;
  email: string;
}
