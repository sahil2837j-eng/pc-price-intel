// Country profile = everything that differs between markets: currency, time zone, number
// format, price markers, where people buy/sell, local vocabulary, optional sanity ranges.
//
// Resolution order (later wins): defaults < countries.json < bundled profile
//   < user profile in <data dir>/profiles/<CC>.json < explicit options.
// Any ISO country works: pass --currency and --tz when it is not in countries.json.

import fs from "node:fs";
import path from "node:path";
import { PcpError } from "./errors.mjs";
import { currencyDecimals, currencySymbol } from "./money.mjs";
import { assetsDir, customProfileDir, loadAsset, readJsonIfExists, writeJsonAtomic } from "./paths.mjs";
import { validateTimezone } from "./timeutil.mjs";

const DEFAULT_LEVEL_LABELS = {
  local_market: "In-person market or shop the user visits or phones",
  online_domestic: "Domestic online shop or classifieds listing",
  other_domestic: "Another domestic channel (social group, other city)",
  unknown: "Unknown",
};

export function normalizeCountryCode(cc) {
  const code = String(cc ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new PcpError("BAD_COUNTRY", `Country must be an ISO 3166-1 alpha-2 code (e.g. PK, IN, US); got "${cc}".`, "Run `pcp country list`.");
  }
  return code;
}

function regionName(cc) {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(cc) || cc;
  } catch {
    return cc;
  }
}

function tableEntry(cc) {
  return loadAsset("data/countries.json").countries.find((c) => c.cc === cc) || null;
}

function bundledProfile(cc) {
  return readJsonIfExists(path.join(assetsDir(), "profiles", `${cc}.json`));
}

function userProfile(cc) {
  return readJsonIfExists(path.join(customProfileDir(), `${cc}.json`));
}

/** All countries the tool knows out of the box. */
export function listCountries() {
  const rich = new Set(
    fs.readdirSync(path.join(assetsDir(), "profiles")).filter((f) => /^[A-Z]{2}\.json$/.test(f)).map((f) => f.slice(0, 2)),
  );
  const user = fs.existsSync(customProfileDir())
    ? fs.readdirSync(customProfileDir()).filter((f) => /^[A-Z]{2}\.json$/.test(f)).map((f) => f.slice(0, 2))
    : [];
  return loadAsset("data/countries.json").countries.map((c) => ({
    cc: c.cc,
    name: c.name,
    currency: c.currency,
    timezone: c.tz,
    rich_profile: rich.has(c.cc),
    user_profile: user.includes(c.cc),
  }));
}

/**
 * Build the effective profile for a country.
 * @param {string} cc
 * @param {{currency?:string, tz?:string}} [opts] explicit overrides (init flags)
 */
export function loadProfile(cc, opts = {}) {
  const code = normalizeCountryCode(cc);
  const table = tableEntry(code);
  const bundled = bundledProfile(code);
  const user = userProfile(code);

  const currency = opts.currency || user?.currency || bundled?.currency || table?.currency;
  const timezone = opts.tz || user?.timezone || bundled?.timezone || table?.tz;
  if (!currency || !timezone) {
    throw new PcpError(
      "UNKNOWN_COUNTRY",
      `No built-in market data for ${code}.`,
      `Re-run with the facts for that country: pcp init --country ${code} --currency <ISO-4217> --tz <Area/City>`,
    );
  }
  const decimals = currencyDecimals(currency.toUpperCase());
  validateTimezone(timezone);
  const symbol = currencySymbol(currency.toUpperCase(), bundled?.locale || "en");

  const merged = {
    country: code,
    label: table?.name || regionName(code),
    currency: currency.toUpperCase(),
    decimals,
    symbol,
    timezone,
    tz_abbr: null,
    tz_note: table?.tz_note || null,
    locale: "en",
    number_format: { thousands: ",", decimal: ".", grouping: "standard" },
    price_markers: { prefix: [symbol, currency.toUpperCase()], suffix: [currency.toUpperCase()] },
    extract_bounds: { min: 1, max: 1_000_000_000 },
    level_labels: DEFAULT_LEVEL_LABELS,
    markets: [],
    online_sources: [],
    local_terms: [],
    search_queries: ["used {model} price in {country}", "{model} price {currency}", "{model} {market} price"],
    sanity: {},
    notes: [],
    reviewed: null,
    verified: false,
    ...(bundled || {}),
    ...(user || {}),
  };
  merged.currency = currency.toUpperCase();
  merged.timezone = timezone;
  merged.decimals = decimals;
  merged.symbol = symbol;
  merged.country = code;
  merged.level_labels = { ...DEFAULT_LEVEL_LABELS, ...(merged.level_labels || {}) };
  merged.number_format = { thousands: ",", decimal: ".", grouping: "standard", ...(merged.number_format || {}) };
  merged.source = user ? "user" : bundled ? "bundled" : "generated";
  return merged;
}

const REQUIRED = ["country", "currency", "timezone"];

/** Validate a profile file an agent produced before saving it. Returns the cleaned object. */
export function validateProfileFile(obj) {
  if (!obj || typeof obj !== "object") throw new PcpError("BAD_PROFILE", "Profile must be a JSON object.");
  for (const k of REQUIRED) if (!obj[k]) throw new PcpError("BAD_PROFILE", `Profile is missing "${k}".`);
  normalizeCountryCode(obj.country);
  currencyDecimals(String(obj.currency).toUpperCase());
  validateTimezone(obj.timezone);
  if (obj.price_markers) {
    for (const side of ["prefix", "suffix"]) {
      if (obj.price_markers[side] && !Array.isArray(obj.price_markers[side])) {
        throw new PcpError("BAD_PROFILE", `price_markers.${side} must be an array of strings.`);
      }
    }
  }
  if (obj.sanity) {
    for (const [comp, r] of Object.entries(obj.sanity)) {
      if (!(Number(r?.min) >= 0) || !(Number(r?.max) > Number(r?.min))) {
        throw new PcpError("BAD_PROFILE", `sanity.${comp} needs min >= 0 and max > min.`);
      }
    }
  }
  const { _comment, ...clean } = obj;
  return { ...clean, country: normalizeCountryCode(obj.country), currency: String(obj.currency).toUpperCase() };
}

export function saveUserProfile(obj) {
  const clean = validateProfileFile(obj);
  writeJsonAtomic(path.join(customProfileDir(), `${clean.country}.json`), clean);
  return clean;
}
