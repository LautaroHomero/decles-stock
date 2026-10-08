/**
 * Shared-secret check for cron-triggered endpoints (`src/app/api/cron/**`).
 * Vercel Cron automatically sends `Authorization: Bearer $CRON_SECRET` on
 * triggered requests when a `CRON_SECRET` env var exists on the project, so
 * this "just works" there; a generic external cron (crontab + curl) can send
 * the same header, or pass `?secret=...` if setting headers is inconvenient.
 */
export function authorizedCronRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured — caller should warn
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const query = new URL(req.url).searchParams.get("secret");
  return bearer === secret || query === secret;
}
