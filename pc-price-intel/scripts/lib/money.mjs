// Money is stored as integer MINOR units (price_minor) plus an ISO 4217 code, so the same
// code works for 0-decimal (PKR, JPY), 2-decimal (USD, EUR) and 3-decimal (KWD) currencies.

import { PcpError } from "./errors.mjs";

/** Number of decimals for a currency, from the platform's Intl data. Throws on unknown codes. */
export function currencyDecimals(code) {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
  } catch {
    throw new PcpError("BAD_CURRENCY", `Unknown ISO 4217 currency code: ${code}`, "Use a 3-letter code such as PKR, USD, EUR.");
  }
}

export function currencySymbol(code, locale = "en") {
  try {
    const parts = new Intl.NumberFormat(locale, { style: "currency", currency: code, currencyDisplay: "narrowSymbol" }).formatToParts(1);
    return parts.find((p) => p.type === "currency")?.value || code;
  } catch {
    return code;
  }
}

export function toMinor(major, decimals) {
  const scaled = major * 10 ** decimals;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6) {
    throw new PcpError("VALIDATION", `Price has more than ${decimals} decimal place(s).`);
  }
  return rounded;
}

export function fromMinor(minor, decimals) {
  return minor / 10 ** decimals;
}

/** 100.5 -> 101 (half-up), never banker's rounding. */
export function roundHalfUp(x) {
  return Math.floor(x + 0.5);
}

/** Median of integer minor units. Even counts average the middle two, half-up. */
export function medianMinor(list) {
  if (list.length === 0) return null;
  const s = list.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : roundHalfUp((s[mid - 1] + s[mid]) / 2);
}

/**
 * Parse a typed price like "47,000" or "1,299.99" using the profile's separators.
 * Rejects "k"/"lakh" suffixes and anything non-numeric: no guessing what the user meant.
 * Returns a number in MAJOR units.
 */
export function parsePriceInput(raw, profile) {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new PcpError("VALIDATION", "Price is not a number.");
    return raw;
  }
  const nf = profile.number_format || { thousands: ",", decimal: "." };
  let s = String(raw ?? "").trim();
  if (!s) throw new PcpError("VALIDATION", "Price is required.");
  s = s.split(nf.thousands).join("").replace(/\s+/g, "");
  if (nf.decimal !== ".") s = s.split(nf.decimal).join(".");
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new PcpError("VALIDATION", `Price "${raw}" is not a plain number (no k, lakh, currency words or signs).`, "Type the full amount, e.g. 47000.");
  }
  return Number(s);
}

export function fmtMoney(minor, profile) {
  if (minor === null || minor === undefined) return "no data";
  const d = profile.decimals;
  const value = minor / 10 ** d;
  let num;
  try {
    num = new Intl.NumberFormat(profile.locale || "en", { minimumFractionDigits: d, maximumFractionDigits: d }).format(value);
  } catch {
    num = new Intl.NumberFormat("en", { minimumFractionDigits: d, maximumFractionDigits: d }).format(value);
  }
  return `${profile.currency} ${num}`;
}

export function fmtPct(p) {
  return p === null || p === undefined ? "—" : `${p.toFixed(1)}%`;
}
