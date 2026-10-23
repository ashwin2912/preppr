import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

/** YYYY-MM-DD in the given zone. */
export const localDate = (now: Date, tz: string) => formatInTimeZone(now, tz, "yyyy-MM-dd");

/** UTC instant for a local wall-clock date + "HH:MM" in the zone. */
export function zonedInstant(date: string, hhmm: string, tz: string): Date {
  const [h, m] = hhmm.split(":");
  return fromZonedTime(`${date}T${h!.padStart(2, "0")}:${m}:00`, tz);
}

/** "10:30 AM" */
export const formatClock = (d: Date, tz: string) => formatInTimeZone(d, tz, "h:mm a");

/** "Mon, Oct 19" */
export const formatDay = (date: string, tz: string) =>
  formatInTimeZone(zonedInstant(date, "12:00", tz), tz, "EEE, MMM d");

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Resolve a weekday word ("Mon", "tuesday") to the nearest date on or after
 * today. Null/unknown words resolve to today.
 */
export function resolveMenuDate(dayWord: string | null, now: Date, tz: string): string {
  const today = localDate(now, tz);
  if (!dayWord) return today;
  const w = dayWord.trim().toLowerCase();
  if (w === "today") return today;
  if (w === "tomorrow") return addDays(today, 1);
  const target = DAYS.findIndex((d) => w.length >= 3 && d.startsWith(w.slice(0, 3)));
  if (target < 0) return today;
  const todayIdx = new Date(`${today}T12:00:00Z`).getUTCDay();
  return addDays(today, (target - todayIdx + 7) % 7);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Parse "10:30", "10.30", "1030", "11", "10:30am", "2pm" into "HH:MM" (24h). */
export function parseClock(s: string): string | null {
  const m = s.trim().toLowerCase().match(/^(\d{1,2})(?:[:.]?(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? "0");
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}
