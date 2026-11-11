/**
 * Ausente en el texto de Anotar: «carla no vino, botox, gabi», «faltó marta a la consulta», «ausente: ana, peeling».
 * Devuelve el texto sin la frase (el resto lo entiende el parser de siempre).
 */
const NO_SHOW =
  /(?:^|[\s,;.:])(no\s+vin(?:o|ieron)|no\s+se\s+present[oó]|no\s+asisti[oó]|no\s+lleg[oó]|falt[oó](?!\s+(?:pagar|plata|cobrar|abonar|la\s+plata))|ausente(?:\s+sin\s+aviso)?|(?:dio|dej[oó])\s+(?:el\s+)?faltazo)(?=$|[\s,;.:])/i;
/** «al turno», «a la consulta», «a su sesión» que quedan colgando. */
const TO_APPOINTMENT = /(?:^|\s)(?:al|a\s+la|a\s+su)\s+(?:turno|consulta|sesi[oó]n)(?=$|[\s,;.:])/i;

export function noShowIn(text: string): { found: boolean; cleaned: string } {
  const m = text.match(NO_SHOW);
  if (!m) return { found: false, cleaned: text };
  const at = m.index! + m[0].indexOf(m[1]);
  const cleaned = (text.slice(0, at) + " " + text.slice(at + m[1].length))
    .replace(TO_APPOINTMENT, " ")
    .replace(/\s+([,;:])/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:]+/, "")
    .trim();
  return { found: true, cleaned };
}
