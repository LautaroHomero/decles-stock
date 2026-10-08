import { authorizedCronRequest } from "@/lib/auth/cron";
import { refreshAllStockAlerts } from "@/lib/domain/notifications";

/** Vercel Cron, una vez por día (ver vercel.json): genera los avisos de vencimiento y stock bajo. */
export async function GET(req: Request) {
  if (!authorizedCronRequest(req)) return Response.json({ ok: false, error: "No autorizado." }, { status: 401 });
  if (!process.env.CRON_SECRET) console.warn("[cron] CRON_SECRET no configurado: el endpoint queda abierto.");
  return Response.json({ ok: true, ...(await refreshAllStockAlerts()) });
}
