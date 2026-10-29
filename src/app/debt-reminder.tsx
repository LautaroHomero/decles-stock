"use client";

/**
 * Fecha para acordarse de cobrar una deuda. Atajos de un toque («Mañana», «En una semana», «En 15 días»,
 * «Fin de mes») y «Otra fecha» con el calendario del navegador. `value` = AAAA-MM-DD o null (sin recordatorio).
 */

const AR = "America/Argentina/Buenos_Aires";
export const todayYmd = () => new Intl.DateTimeFormat("en-CA", { timeZone: AR }).format(new Date());
const at = (s: string) => new Date(`${s}T12:00:00Z`);
function plusDays(s: string, n: number) {
  const d = at(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const endOfMonth = (s: string) => {
  const d = at(s);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)).toISOString().slice(0, 10);
};

/** «viernes 23 de octubre» (con «hoy» / «mañana» cuando corresponde). */
export function remindLabel(ymd: string): string {
  const today = todayYmd();
  if (ymd === today) return "hoy";
  if (ymd === plusDays(today, 1)) return "mañana";
  const s = new Intl.DateTimeFormat("es-AR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(at(ymd));
  return s.replace(",", "");
}

export function ReminderPicker({
  value,
  onChange,
  chip,
  chipOn,
  label = "¿Cuándo hay que cobrarle?",
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  chip: string;
  chipOn: string;
  label?: string;
}) {
  const today = todayYmd();
  const options: [string, string | null][] = [
    ["Mañana", plusDays(today, 1)],
    ["En una semana", plusDays(today, 7)],
    ["En 15 días", plusDays(today, 15)],
    ["Fin de mes", endOfMonth(today)],
    ["Sin recordatorio", null],
  ];
  const custom = value !== null && !options.some(([, v]) => v === value);
  return (
    <div className="flex flex-col gap-2" role="group" aria-label={label}>
      <span className="text-[16px] font-semibold">
        {label}{" "}
        <span className="text-[14px] font-normal text-neutral-500">
          {value ? `· te aviso el ${remindLabel(value)}` : "· si no sabés, dejalo"}
        </span>
      </span>
      <div className="flex flex-wrap items-center gap-2.5">
        {options.map(([text, v]) => (
          <button key={text} type="button" aria-pressed={value === v} onClick={() => onChange(v)} className={value === v ? chipOn : chip}>
            {text}
          </button>
        ))}
        <label className={`${custom ? chipOn : chip} inline-flex cursor-pointer items-center gap-2`}>
          <span>Otra fecha</span>
          <input
            type="date"
            min={today}
            value={value ?? ""}
            onChange={(e) => onChange(e.target.value || null)}
            aria-label="Elegir otra fecha"
            className="bg-transparent text-[15px] outline-none [color-scheme:light_dark]"
          />
        </label>
      </div>
    </div>
  );
}
