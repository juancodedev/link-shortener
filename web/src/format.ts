/**
 * Display helpers for the Spanish UI.
 *
 * The analytics windows ("1 day", "30 minutes", "30 days") come from the API,
 * where they are also the SQL intervals, so the server keeps them in English.
 * This turns the known shapes into Spanish for display only; anything else is
 * shown as the server sent it, so the text never describes a window the query
 * did not use.
 */

/** The locale every date and number on the dashboard is formatted with. */
export const LOCALE = "es-CL";

const UNITS: Record<string, [string, string]> = {
  minute: ["minuto", "minutos"],
  hour: ["hora", "horas"],
  day: ["día", "días"],
  week: ["semana", "semanas"],
  month: ["mes", "meses"],
};

export function spanishWindow(window: string): string {
  const m = /^\s*(\d+)\s+(minute|hour|day|week|month)s?\s*$/i.exec(window);
  if (!m) return window;
  const n = Number(m[1]);
  const [one, many] = UNITS[m[2]!.toLowerCase()]!;
  return `${m[1]} ${n === 1 ? one : many}`;
}
