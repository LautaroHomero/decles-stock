import { dolarHoy, setDolarHoy } from "@/lib/domain/dolar";
import { actorOr401, bodyOf, respond } from "../_http";

/** Dólar blue de hoy y la cotización para cobrar (promedio compra/venta, o la escrita a mano). */
export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await dolarHoy(actor));
}

/** `{ rate }`: cotización de hoy a mano (null = volver al blue). */
export async function PUT(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  const b = await bodyOf<{ rate: number | null }>(req);
  return respond(await setDolarHoy(actor, b.rate ?? null));
}
