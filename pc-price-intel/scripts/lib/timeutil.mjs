// Every "now" comes from here, so tests (and agents replaying history) can pin the clock.
// Store UTC. Display and "today" use the country's IANA time zone.

import { PcpError } from "./errors.mjs";

let clockOverride = null;

/** In-process clock override (tests). Pass null to clear. */
export function setClock(fn) {
  clockOverride = fn;
}

export function nowUtc() {
  if (clockOverride) return clockOverride();
  if (process.env.PCP_NOW) {
    const d = new Date(process.env.PCP_NOW);
    if (Number.isNaN(d.getTime())) throw new PcpError("BAD_CLOCK", `PCP_NOW is not a valid ISO date: ${process.env.PCP_NOW}`);
    return d;
  }
  return new Date();
}

/** UTC timestamp as YYYY-MM-DDTHH:MM:SSZ */
export function isoUtc(d = nowUtc()) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function validateTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new PcpError("BAD_TIMEZONE", `Unknown IANA time zone: ${tz}`, "Use a name like Asia/Karachi or Europe/London.");
  }
  return tz;
}

/** YYYY-MM-DD of the instant `d` as seen in zone `tz`. */
export function localDate(d, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function daysBetween(a, b) {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  return Math.round((db - da) / 86400000);
}

export function addDays(dateStr, n) {
  const d = new Date(Date.parse(`${dateStr}T00:00:00Z`));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isDateString(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function ageLabel(dateStr, today) {
  if (!dateStr) return "no data";
  const n = daysBetween(dateStr, today);
  if (n <= 0) return "today";
  if (n === 1) return "1 day ago";
  return `${n} days ago`;
}

/** "14 Jan 2025, 03:40 PM PKT" for a stored UTC timestamp. */
export function fmtDateTimeLocal(iso, tz, abbr) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short", year: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: true }).format(d);
  const zone = abbr || new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value || tz;
  return `${date}, ${time} ${zone}`;
}

/** "14 Jan 2025" for a plain YYYY-MM-DD local date. */
export function fmtDate(dateStr) {
  if (!dateStr) return "—";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [y, m, d] = dateStr.split("-").map((v) => parseInt(v, 10));
  if (!y || !m || !d) return dateStr;
  return `${d} ${months[m - 1]} ${y}`;
}
