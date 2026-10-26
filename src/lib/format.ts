const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact age for dense rows: "agora", "12min", "5h", "3d". */
export function age(iso: string | null, now: number = Date.now()): string {
  if (iso === null) return "";
  const ms = now - Date.parse(iso);
  if (ms < MINUTE) return "agora";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}min`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

export function clock(date: Date): string {
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}
