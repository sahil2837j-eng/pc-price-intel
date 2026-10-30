// Export / import, plus a bridge to the PC Market Watcher web app's JSON format.
//
// Import is DRY-RUN first. Same uuid + identical fields = skip. Same uuid + different fields
// = conflict, LOCAL KEPT, never overwritten. A missing reference marks that row invalid.
// A higher/unknown version, wrong country or wrong currency imports NOTHING. All accepted
// rows are written in ONE append, so a power cut cannot leave half an import.
// Network/collection-style settings are never importable; only analysis settings are, and only
// with an explicit flag.

import { assertMergeAllowed } from "./alias.mjs";
import { setConfigValue, setSanity } from "./config.mjs";
import { APP_EXPORT_FORMAT, COMPONENTS, CONDITIONS, EXPORT_FORMAT, EXPORT_VERSION, ITEM_KINDS, LEVELS, PRICE_TYPES } from "./consts.mjs";
import { PcpError } from "./errors.mjs";
import { currencyDecimals, toMinor } from "./money.mjs";
import { buildKey, buildSellerKey } from "./normalize.mjs";
import { sanityFlag } from "./observations.mjs";
import { ev } from "./store.mjs";
import { isoUtc } from "./timeutil.mjs";

const SETTINGS_ALLOWLIST = ["window_days", "min_samples", "min_sellers", "trend_flat_pct", "bands", "sanity", "extra_vendor_words", "extra_subbrand_words", "extra_capacity_redundant", "extra_risk_terms"];

export function exportData(ctx, state) {
  const settings = {};
  for (const k of SETTINGS_ALLOWLIST) settings[k] = ctx.config[k];
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exported_at: isoUtc(),
    country: ctx.cc,
    currency: ctx.profile.currency,
    observations: state.observations.map((o) => ({
      uuid: o.uuid,
      component: o.component,
      raw_name: o.raw_name,
      specs: o.specs,
      item_kind: o.item_kind,
      price: o.price_minor / 10 ** currencyDecimals(o.currency),
      currency: o.currency,
      price_type: o.price_type,
      condition: o.condition,
      seller: o.seller,
      location: o.location,
      location_level: o.location_level,
      observed_date: o.observed_date,
      evidence: o.evidence,
      warranty: o.warranty,
      source_ref: o.source_ref,
      notes: o.notes,
      sanity_override: o.sanity_override,
      duplicate_of: o.duplicate_of,
      correction_of: o.correction_of,
      voided_at: o.voided_at,
      void_reason: o.void_reason,
      created_at: o.ts,
    })),
    aliases: [...state.aliases].map(([alias_key, canonical_key]) => ({ alias_key, canonical_key })),
    settings,
  };
}

function incomingMinor(o) {
  const dec = currencyDecimals(String(o.currency).toUpperCase());
  return toMinor(Number(o.price), dec);
}

function sameFields(inc, ex) {
  let minor;
  try {
    minor = incomingMinor(inc);
  } catch {
    return false;
  }
  const n = (v) => (v === undefined || v === "" ? null : v);
  return (
    inc.component === ex.component &&
    inc.raw_name === ex.raw_name &&
    n(inc.specs) === n(ex.specs) &&
    inc.item_kind === ex.item_kind &&
    minor === ex.price_minor &&
    String(inc.currency).toUpperCase() === ex.currency &&
    inc.price_type === ex.price_type &&
    inc.condition === ex.condition &&
    n(inc.seller) === n(ex.seller) &&
    n(inc.location) === n(ex.location) &&
    inc.location_level === ex.location_level &&
    inc.observed_date === ex.observed_date &&
    n(inc.notes) === n(ex.notes) &&
    n(inc.duplicate_of) === n(ex.duplicate_of) &&
    n(inc.correction_of) === n(ex.correction_of) &&
    Boolean(inc.voided_at) === Boolean(ex.voided_at)
  );
}

function validRow(o) {
  if (!o || !o.uuid || !o.raw_name) return false;
  if (!COMPONENTS.includes(o.component)) return false;
  if (!(Number(o.price) > 0)) return false;
  if (!PRICE_TYPES.includes(o.price_type) || !CONDITIONS.includes(o.condition)) return false;
  if (o.item_kind && !ITEM_KINDS.includes(o.item_kind)) return false;
  if (o.location_level && !LEVELS.includes(o.location_level)) return false;
  try {
    incomingMinor(o);
  } catch {
    return false;
  }
  return true;
}

export function analyzeImport(ctx, state, payload) {
  const reject = (error) => ({ ok: false, error, counts: null });
  if (!payload || payload.format !== EXPORT_FORMAT) return reject(`Unrecognised file format (expected ${EXPORT_FORMAT}). Nothing will be imported.`);
  if (!payload.version || payload.version > EXPORT_VERSION) return reject(`Unsupported export version ${payload.version}. Nothing will be imported.`);
  if (payload.country !== ctx.cc || String(payload.currency).toUpperCase() !== ctx.profile.currency) {
    return reject(`File is for ${payload.country}/${payload.currency} but the active market is ${ctx.cc}/${ctx.profile.currency}. Nothing will be imported.`);
  }
  const incoming = Array.isArray(payload.observations) ? payload.observations : [];
  const incomingUuids = new Set(incoming.map((o) => o?.uuid));
  const add = [];
  const identical = [];
  const conflict = [];
  const invalid = [];
  for (const o of incoming) {
    if (!validRow(o)) {
      invalid.push(o?.uuid ?? "(missing uuid)");
      continue;
    }
    const refOk = (u) => !u || incomingUuids.has(u) || state.byUuid.has(u);
    if (!refOk(o.duplicate_of) || !refOk(o.correction_of)) {
      invalid.push(o.uuid);
      continue;
    }
    const ex = state.byUuid.get(o.uuid);
    if (!ex) add.push(o.uuid);
    else if (sameFields(o, ex)) identical.push(o.uuid);
    else conflict.push(o.uuid);
  }
  return {
    ok: true,
    counts: { add: add.length, identical: identical.length, conflict: conflict.length, invalid: invalid.length },
    details: { add, identical, conflict, invalid },
  };
}

export function applyImport(ctx, state, payload, { applySettings = false } = {}) {
  const dry = analyzeImport(ctx, state, payload);
  if (!dry.ok) return dry;
  const addSet = new Set(dry.details.add);
  let nextId = state.maxId;
  const events = [];
  for (const o of payload.observations) {
    if (!addSet.has(o.uuid)) continue;
    const currency = String(o.currency).toUpperCase();
    const price_minor = incomingMinor(o);
    const component = o.component;
    const isRef = currency !== ctx.profile.currency || o.evidence === "reference";
    events.push(
      ev("obs", {
        ts: o.created_at || isoUtc(),
        id: ++nextId,
        uuid: o.uuid,
        component,
        raw_name: o.raw_name,
        specs: o.specs ?? null,
        model_key: buildKey(component, o.raw_name, o.specs, ctx.config), // recomputed locally
        item_kind: o.item_kind || "single",
        price_minor,
        currency,
        price_type: o.price_type,
        condition: o.condition,
        seller: o.seller ?? null,
        seller_key: buildSellerKey(o.seller) || null,
        location: o.location ?? null,
        location_level: o.location_level || "unknown",
        observed_date: o.observed_date,
        evidence: o.evidence || "observed",
        warranty: o.warranty ?? null,
        source_ref: o.source_ref ?? null,
        notes: o.notes ?? null,
        sanity_flag: isRef ? "ok" : sanityFlag(component, price_minor, ctx, currency), // recomputed locally
        duplicate_of: o.duplicate_of ?? null,
        correction_of: o.correction_of ?? null,
      }),
    );
    if (o.voided_at) events.push(ev("void", { ts: o.voided_at, uuid: o.uuid, reason: o.void_reason ?? null }));
    if (o.sanity_override) events.push(ev("override", { uuid: o.uuid, value: true }));
  }
  let aliasAdded = 0;
  let aliasSkipped = 0;
  const tmp = new Map(state.aliases);
  for (const a of payload.aliases || []) {
    if (!a?.alias_key || !a?.canonical_key || tmp.has(a.alias_key)) continue;
    try {
      assertMergeAllowed(tmp, a.alias_key, a.canonical_key);
      tmp.set(a.alias_key, a.canonical_key);
      events.push(ev("alias", { alias_key: a.alias_key, canonical_key: a.canonical_key }));
      aliasAdded++;
    } catch {
      aliasSkipped++;
    }
  }
  ctx.store.append(events); // ONE write: all or (on power cut) at worst a torn last line
  let settingsApplied = [];
  if (applySettings && payload.settings) {
    for (const k of SETTINGS_ALLOWLIST) {
      const v = payload.settings[k];
      if (v === undefined) continue;
      if (k === "sanity") {
        for (const [comp, r] of Object.entries(v || {})) setSanity(ctx.cc, comp, r.min, r.max);
      } else if (k === "bands") {
        for (const [b, n] of Object.entries(v || {})) setConfigValue(ctx.cc, `bands.${b}`, n);
      } else if (Array.isArray(v) && k === "extra_risk_terms") {
        setConfigValue(ctx.cc, k, v.map((t) => `${t.term}:${t.severity}`).join(","));
      } else if (Array.isArray(v)) {
        setConfigValue(ctx.cc, k, v.join(","));
      } else {
        setConfigValue(ctx.cc, k, v);
      }
      settingsApplied.push(k);
    }
  }
  return { ...dry, applied: { observations: dry.counts.add, aliases_added: aliasAdded, aliases_skipped: aliasSkipped, settings: settingsApplied } };
}

// ---------------------------------------------------------------------------
// Bridge to the PC Market Watcher web app (pc-market-watcher-export v1, PKR, whole rupees)
// ---------------------------------------------------------------------------

const LEVEL_TO_APP = { local_market: "peshawar_shop", online_domestic: "pakistan_online", other_domestic: "pakistan_other", unknown: "unknown" };
const LEVEL_FROM_APP = Object.fromEntries(Object.entries(LEVEL_TO_APP).map(([k, v]) => [v, k]));

/** App export -> this tool's export format (then use the normal dry-run/confirm import). */
export function appToPcp(app, ctx) {
  if (!app || app.format !== APP_EXPORT_FORMAT) throw new PcpError("BAD_FORMAT", `Not a ${APP_EXPORT_FORMAT} file.`);
  if (ctx.profile.currency !== "PKR") throw new PcpError("BRIDGE_MISMATCH", "The web app stores PKR. Switch to the PK market first: pcp init --country PK.");
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exported_at: app.exported_at || isoUtc(),
    country: "PK",
    currency: "PKR",
    observations: (app.observations || []).map((o) => ({
      uuid: o.uuid,
      component: o.component,
      raw_name: o.raw_name,
      specs: o.specs ?? null,
      item_kind: o.item_kind,
      price: o.price_pkr,
      currency: "PKR",
      price_type: o.price_type,
      condition: o.condition,
      seller: o.seller ?? null,
      location: o.location ?? null,
      location_level: LEVEL_FROM_APP[o.location_level] || "unknown",
      observed_date: o.observed_date,
      evidence: o.evidence || "observed",
      warranty: o.warranty ?? null,
      source_ref: o.source_ref ?? null,
      notes: o.notes ?? null,
      sanity_override: Boolean(o.sanity_override),
      duplicate_of: o.duplicate_of ?? null,
      correction_of: o.correction_of ?? null,
      voided_at: o.voided_at ?? null,
      void_reason: o.void_reason ?? null,
      created_at: o.created_at,
    })),
    aliases: [], // model keys differ between normaliser versions; re-create merges with `pcp alias merge`
    settings: {},
  };
}

/** This tool's data -> web-app export (PKR only; reference rows are skipped). */
export function pcpToApp(state, ctx) {
  if (ctx.profile.currency !== "PKR" || ctx.profile.decimals !== 0) {
    throw new PcpError("BRIDGE_MISMATCH", "Only a PKR (0-decimal) market can be exported for the web app.");
  }
  const rows = state.observations.filter((o) => o.currency === "PKR" && o.evidence !== "reference");
  return {
    format: APP_EXPORT_FORMAT,
    version: 1,
    exported_at: isoUtc(),
    observations: rows.map((o) => ({
      uuid: o.uuid,
      component: o.component,
      raw_name: o.raw_name,
      specs: o.specs,
      model_key: o.model_key,
      item_kind: o.item_kind,
      price_pkr: o.price_minor,
      price_type: o.price_type,
      condition: o.condition,
      seller: o.seller,
      seller_key: o.seller_key,
      location: o.location,
      location_level: LEVEL_TO_APP[o.location_level] || "unknown",
      observed_date: o.observed_date,
      evidence: o.evidence,
      warranty: o.warranty,
      source_ref: o.source_ref,
      notes: o.notes,
      sanity_flag: o.sanity_flag,
      sanity_override: o.sanity_override,
      duplicate_of: o.duplicate_of,
      correction_of: o.correction_of,
      voided_at: o.voided_at,
      void_reason: o.void_reason,
      created_at: o.ts,
    })),
    model_alias: [],
    settings: {},
    skipped_reference_rows: state.observations.length - rows.length,
  };
}
