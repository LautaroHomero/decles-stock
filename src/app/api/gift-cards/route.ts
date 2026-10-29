import { giftCardBalance } from "@/lib/domain/gift-cards";
import { actorOr401, respond } from "../_http";

export async function GET(req: Request) {
  const actor = await actorOr401(req);
  if (actor instanceof Response) return actor;
  return respond(await giftCardBalance(actor, new URL(req.url).searchParams.get("code") ?? ""));
}