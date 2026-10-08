/** Zona horaria del consultorio. Vercel corre en UTC: sin esto, "hoy" cambia a las 21 h. */
export const APP_TZ = process.env.APP_TZ || "America/Argentina/Buenos_Aires";

const FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/**
 * La hora real en la zona del consultorio, `YYYY-MM-DDThh:mm:ss` (misma convención
 * que Clavdia: timestamps TEXT que ordenan lexicográficamente).
 */
export function realNowIso(): string {
  const p = Object.fromEntries(FMT.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
