// Per-country settings. Only OVERRIDES are stored (<data>/<CC>/config.json); defaults come
// from code and the profile, so upgrading the skill never freezes old defaults.

import path from "node:path";
import { COMPONENTS, DEFAULT_CONFIG } from "./consts.mjs";
import { PcpError } from "./errors.mjs";
import { countryDir, readJsonIfExists, writeJsonAtomic } from "./paths.mjs";
import { validateTimezone } from "./timeutil.mjs";

const NUMERIC = {
  window_days: { min: 1, int: true },
  min_samples: { min: 1, int: true },
  min_sellers: { min: 1, int: true },
  trend_flat_pct: { min: 0, int: false },
};
const LIST_KEYS = ["extra_vendor_words", "extra_subbrand_words", "extra_capacity_redundant"];
const BAND_KEYS = ["much_below", "below", "above", "much_above"];

export function configPath(cc) {
  return path.join(countryDir(cc), "config.json");
}

export function loadSaved(cc) {
  return readJsonIfExists(configPath(cc)) || {};
}

/** Effective config = code defaults < profile defaults < saved overrides. */
export function loadConfig(cc, profile) {
  const saved = loadSaved(cc);
  const cfg = {
    ...DEFAULT_CONFIG,
    bands: { ...DEFAULT_CONFIG.bands, ...(saved.bands || {}) },
    sanity: { ...(profile.sanity || {}), ...(saved.sanity || {}) },
    timezone: saved.timezone || profile.timezone,
    home_market: saved.home_market || null,
    extra_vendor_words: saved.extra_vendor_words || [],
    extra_subbrand_words: saved.extra_subbrand_words || [],
    extra_capacity_redundant: saved.extra_capacity_redundant || [],
    extra_risk_terms: saved.extra_risk_terms || [],
  };
  for (const k of Object.keys(NUMERIC)) if (saved[k] !== undefined) cfg[k] = saved[k];
  return cfg;
}

function checkBands(b) {
  if (!(b.much_below < b.below && b.below < b.above && b.above < b.much_above) || b.much_below <= 0) {
    throw new PcpError("VALIDATION", "Bands must satisfy 0 < much_below < below < above < much_above.");
  }
}

function mutate(cc, fn) {
  const saved = loadSaved(cc);
  fn(saved);
  writeJsonAtomic(configPath(cc), saved);
  return saved;
}

export function setConfigValue(cc, key, raw) {
  if (NUMERIC[key]) {
    const n = Number(raw);
    const rule = NUMERIC[key];
    if (!Number.isFinite(n) || n < rule.min || (rule.int && !Number.isInteger(n))) {
      throw new PcpError("VALIDATION", `${key} must be ${rule.int ? "a whole number" : "a number"} >= ${rule.min}.`);
    }
    return mutate(cc, (s) => (s[key] = n));
  }
  if (key.startsWith("bands.")) {
    const band = key.slice(6);
    if (!BAND_KEYS.includes(band)) throw new PcpError("VALIDATION", `Unknown band "${band}". Use ${BAND_KEYS.join(", ")}.`);
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new PcpError("VALIDATION", "A band must be a positive number.");
    return mutate(cc, (s) => {
      const next = { ...DEFAULT_CONFIG.bands, ...(s.bands || {}), [band]: n };
      checkBands(next);
      s.bands = next;
    });
  }
  if (key === "timezone") {
    validateTimezone(String(raw));
    return mutate(cc, (s) => (s.timezone = String(raw)));
  }
  if (key === "home_market") return mutate(cc, (s) => (s.home_market = String(raw).slice(0, 120)));
  if (LIST_KEYS.includes(key)) {
    const list = String(raw).split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
    return mutate(cc, (s) => (s[key] = list));
  }
  if (key === "extra_risk_terms") {
    const list = String(raw)
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const [term, sev = "medium"] = p.split(":").map((x) => x.trim());
        if (!["low", "medium", "high"].includes(sev)) throw new PcpError("VALIDATION", `Severity must be low|medium|high (got ${sev}).`);
        return { term: term.toLowerCase(), severity: sev };
      });
    return mutate(cc, (s) => (s.extra_risk_terms = list));
  }
  throw new PcpError(
    "VALIDATION",
    `Unknown config key "${key}".`,
    `Keys: ${[...Object.keys(NUMERIC), "bands.<name>", "timezone", "home_market", ...LIST_KEYS, "extra_risk_terms"].join(", ")}. For price ranges use: pcp config sanity <COMPONENT> <min> <max>.`,
  );
}

/** Sanity range in MAJOR units: a flag range, never a price claim. */
export function setSanity(cc, component, min, max) {
  const comp = String(component).toUpperCase();
  if (!COMPONENTS.includes(comp)) throw new PcpError("VALIDATION", `Component must be one of ${COMPONENTS.join(", ")}.`);
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi <= lo) {
    throw new PcpError("VALIDATION", "Sanity range needs min >= 0 and max > min.");
  }
  return mutate(cc, (s) => {
    s.sanity = { ...(s.sanity || {}), [comp]: { min: lo, max: hi } };
  });
}

export function resetConfig(cc, key) {
  if (!key) return mutate(cc, (s) => { for (const k of Object.keys(s)) delete s[k]; });
  return mutate(cc, (s) => {
    if (key.startsWith("bands.")) {
      if (s.bands) delete s.bands[key.slice(6)];
    } else if (key.startsWith("sanity.")) {
      if (s.sanity) delete s.sanity[key.slice(7).toUpperCase()];
    } else {
      delete s[key];
    }
  });
}
