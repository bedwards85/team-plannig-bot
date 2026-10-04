/** Small, dependency-free helpers for showing times in a person's own time zone. */

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/** e.g. "Mon 12 Oct 2026, 09:14" in the given IANA time zone. */
export function localStamp(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")}`;
}

/** The local calendar date (YYYY-MM-DD) of the Monday that starts the week containing `at`. */
export function weekStart(at: Date, timeZone: string): string {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => local.find((p) => p.type === type)?.value ?? "";
  const dayIndex = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  const date = new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day"))));
  date.setUTCDate(date.getUTCDate() - Math.max(dayIndex, 0));
  return date.toISOString().slice(0, 10);
}

/** "12 Oct" from "2026-10-12". */
export function shortDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(d);
}
