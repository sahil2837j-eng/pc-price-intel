// Write operations on observations. Validation is strict and has NO defaults for
// price type or condition: if the user did not say, the agent must ask.

import { randomUUID } from "node:crypto";
import { assertMergeAllowed } from "./alias.mjs";
import { COMPONENTS, CONDITIONS, EVIDENCE, ITEM_KINDS, LEVELS, PRICE_TYPES } from "./consts.mjs";
import { PcpError } from "./errors.mjs";
import { currencyDecimals, parsePriceInput, toMinor } from "./money.mjs";
import { buildKey, buildSellerKey } from "./normalize.mjs";
import { ev } from "./store.mjs";
import { daysBetween, isDateString } from "./timeutil.mjs";

const oneOf = (list, v) => list.includes(v);

/** Returns { errors, value } where value is normalised input (price as minor units). */
export function validateInput(raw, ctx, { partial = false } = {}) {
  const errors = [];
  const v = {};
  const need = (field, message) => errors.push({ field, message });
  const has = (k) => raw[k] !== undefined && raw[k] !== null && String(raw[k]).trim() !== "";

  if (has("component")) {
    v.component = String(raw.component).toUpperCase();
    if (!oneOf(COMPONENTS, v.component)) need("component", `component must be one of ${COMPONENTS.join(", ")}.`);
  } else if (!partial) need("component", "component is required.");

  if (has("name")) v.raw_name = String(raw.name).trim();
  else if (!partial) need("name", "model name is required.");

  const currency = has("currency") ? String(raw.currency).toUpperCase() : ctx.profile.currency;
  v.currency = currency;
  if (has("price")) {
    try {
      const major = parsePriceInput(raw.price, ctx.profile);
      if (!(major > 0)) throw new PcpError("VALIDATION", "Price must be greater than 0.");
      v.price_minor = toMinor(major, currencyDecimals(currency));
    } catch (e) {
      need("price", e.message);
    }
  } else if (!partial) need("price", "price is required.");

  if (has("type")) {
    v.price_type = String(raw.type).toLowerCase();
    if (!oneOf(PRICE_TYPES, v.price_type)) need("type", `type must be ${PRICE_TYPES.join(" or ")}.`);
  } else if (!partial) need("type", "type (asking or sold) is required. There is no default: ask the user.");

  if (has("condition")) {
    v.condition = String(raw.condition).toLowerCase();
    if (!oneOf(CONDITIONS, v.condition)) need("condition", `condition must be one of ${CONDITIONS.join(", ")}.`);
  } else if (!partial) need("condition", "condition is required. There is no default: ask the user.");

  if (has("kind")) {
    v.item_kind = String(raw.kind).toLowerCase();
    if (!oneOf(ITEM_KINDS, v.item_kind)) need("kind", `kind must be one of ${ITEM_KINDS.join(", ")}.`);
  }
  if (has("level")) {
    v.location_level = String(raw.level).toLowerCase();
    if (!oneOf(LEVELS, v.location_level)) need("level", `level must be one of ${LEVELS.join(", ")}.`);
  }
  if (has("evidence")) {
    v.evidence = String(raw.evidence).toLowerCase();
    if (!oneOf(EVIDENCE, v.evidence)) need("evidence", `evidence must be one of ${EVIDENCE.join(", ")}.`);
  }
  if (has("date")) {
    if (!isDateString(String(raw.date))) need("date", "date must be a real YYYY-MM-DD (local date in the country's time zone).");
    else if (daysBetween(String(raw.date), ctx.today()) < 0) need("date", `date ${raw.date} is in the future for this country (today is ${ctx.today()}).`);
    else v.observed_date = String(raw.date);
  }
  for (const [flag, field] of [["specs", "specs"], ["seller", "seller"], ["location", "location"], ["warranty", "warranty"], ["notes", "notes"], ["source", "source_ref"]]) {
    if (has(flag)) v[field] = String(raw[flag]).trim();
  }
  return { errors, value: v };
}

export function sanityFlag(component, priceMinor, ctx, currency) {
  if (currency !== ctx.profile.currency) return "ok"; // ranges are only defined in the home currency
  const range = ctx.config.sanity?.[component] || ctx.config.sanity?.OTHER;
  if (!range) return "ok"; // unknown range -> ok, never invent a threshold
  const major = priceMinor / 10 ** ctx.profile.decimals;
  if (major < range.min) return "too_low";
  if (major > range.max) return "too_high";
  return "ok";
}

function failIfErrors(errors) {
  if (errors.length) {
    throw new PcpError("VALIDATION", errors.map((e) => `${e.field}: ${e.message}`).join(" | "), "Fix the listed fields and retry. Never fill price type or condition with a guess.", { errors });
  }
}

export function logObservation(ctx, raw, state = ctx.store.state()) {
  const { errors, value } = validateInput(raw, ctx);
  failIfErrors(errors);

  const isRef = value.currency !== ctx.profile.currency || value.evidence === "reference";
  const model_key = buildKey(value.component, value.raw_name, value.specs, ctx.config);
  const seller_key = buildSellerKey(value.seller);
  const item_kind = value.item_kind || "single";
  const observed_date = value.observed_date || ctx.today();
  const location_level = value.location_level || "unknown";

  // Duplicate = same non-empty seller + same RESOLVED key + same kind/condition/type/price, within 1 day.
  // Detected at insert time only. A different price is kept as a separate row.
  let duplicate_of = null;
  if (seller_key && !isRef) {
    const resolved = state.resolve(model_key);
    const hit = state.observations.find(
      (o) =>
        !o.voided_at &&
        !o.duplicate_of &&
        o.seller_key === seller_key &&
        state.resolve(o.model_key) === resolved &&
        o.item_kind === item_kind &&
        o.condition === value.condition &&
        o.price_type === value.price_type &&
        o.price_minor === value.price_minor &&
        Math.abs(daysBetween(o.observed_date, observed_date)) <= 1,
    );
    if (hit) duplicate_of = hit.uuid;
  }

  const event = ev("obs", {
    id: state.maxId + 1,
    uuid: randomUUID(),
    component: value.component,
    raw_name: value.raw_name,
    specs: value.specs ?? null,
    model_key,
    item_kind,
    price_minor: value.price_minor,
    currency: value.currency,
    price_type: value.price_type,
    condition: value.condition,
    seller: value.seller ?? null,
    seller_key: seller_key || null,
    location: value.location ?? null,
    location_level,
    observed_date,
    evidence: isRef ? "reference" : value.evidence || "observed",
    warranty: value.warranty ?? null,
    source_ref: value.source_ref ?? null,
    notes: value.notes ?? null,
    sanity_flag: isRef ? "ok" : sanityFlag(value.component, value.price_minor, ctx, value.currency),
    duplicate_of,
    correction_of: null,
  });
  ctx.store.append([event]);
  return { event, duplicate_of_row: duplicate_of ? state.byUuid.get(duplicate_of) : null, reference_only: isRef };
}

export function findObservation(state, ref) {
  const s = String(ref).trim();
  if (/^\d+$/.test(s)) {
    const o = state.byId.get(Number(s));
    if (o) return o;
  } else if (s.length >= 8) {
    const hits = state.observations.filter((o) => o.uuid.startsWith(s));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new PcpError("AMBIGUOUS", `"${s}" matches ${hits.length} rows. Use more characters or the numeric id.`);
  }
  throw new PcpError("NOT_FOUND", `No observation matches "${ref}".`, "Use `pcp list` to find ids.");
}

/** Correction = NEW row linked to the original; the original is untouched and becomes ineligible. */
export function correctObservation(ctx, ref, raw, state = ctx.store.state()) {
  const orig = findObservation(state, ref);
  // Parse a corrected price in the ORIGINAL row's currency unless the caller says otherwise.
  const { errors, value } = validateInput({ ...raw, currency: raw.currency ?? orig.currency }, ctx, { partial: true });
  failIfErrors(errors);

  const merged = {
    component: value.component ?? orig.component,
    raw_name: value.raw_name ?? orig.raw_name,
    specs: value.specs ?? orig.specs,
    price_minor: value.price_minor ?? orig.price_minor,
    currency: value.currency && raw.currency ? value.currency : orig.currency,
    price_type: value.price_type ?? orig.price_type,
    condition: value.condition ?? orig.condition,
    seller: value.seller ?? orig.seller,
    location: value.location ?? orig.location,
    location_level: value.location_level ?? orig.location_level,
    observed_date: value.observed_date ?? orig.observed_date,
    item_kind: value.item_kind ?? orig.item_kind,
    warranty: value.warranty ?? orig.warranty,
    notes: value.notes ?? orig.notes,
    source_ref: value.source_ref ?? orig.source_ref,
    evidence: value.evidence ?? orig.evidence,
  };
  const isRef = merged.currency !== ctx.profile.currency || merged.evidence === "reference";
  const seller_key = buildSellerKey(merged.seller);
  const event = ev("obs", {
    id: state.maxId + 1,
    uuid: randomUUID(),
    ...merged,
    model_key: buildKey(merged.component, merged.raw_name, merged.specs, ctx.config),
    seller_key: seller_key || null,
    evidence: isRef ? "reference" : merged.evidence,
    sanity_flag: isRef ? "ok" : sanityFlag(merged.component, merged.price_minor, ctx, merged.currency),
    duplicate_of: null,
    correction_of: orig.uuid,
  });
  ctx.store.append([event]);
  return { event, original: orig };
}

export function voidObservation(ctx, ref, reason, state = ctx.store.state()) {
  if (!reason || !String(reason).trim()) throw new PcpError("VALIDATION", "A void reason is required.", "Pass --reason \"why\".");
  const o = findObservation(state, ref);
  ctx.store.append([ev("void", { uuid: o.uuid, reason: String(reason).trim() })]);
  return o;
}

export function unvoidObservation(ctx, ref, state = ctx.store.state()) {
  const o = findObservation(state, ref);
  ctx.store.append([ev("unvoid", { uuid: o.uuid })]);
  return o;
}

export function unmarkDuplicate(ctx, ref, state = ctx.store.state()) {
  const o = findObservation(state, ref);
  ctx.store.append([ev("unmark_dup", { uuid: o.uuid })]);
  return o;
}

export function overrideSanity(ctx, ref, value = true, state = ctx.store.state()) {
  const o = findObservation(state, ref);
  ctx.store.append([ev("override", { uuid: o.uuid, value })]);
  return o;
}

export function chainOf(state, ref) {
  let root = findObservation(state, ref);
  while (root.correction_of && state.byUuid.has(root.correction_of)) root = state.byUuid.get(root.correction_of);
  const chain = [root];
  let cur = root;
  for (;;) {
    const next = state.observations.find((o) => o.correction_of === cur.uuid);
    if (!next) break;
    chain.push(next);
    cur = next;
  }
  return chain;
}

export function rowStatus(o, superseded) {
  if (o.voided_at) return "voided";
  if (superseded.has(o.uuid)) return "corrected";
  if (o.duplicate_of) return "duplicate";
  if (o.evidence === "reference") return "reference";
  return "active";
}

export function mergeAlias(ctx, aliasKey, canonicalKey, state = ctx.store.state()) {
  assertMergeAllowed(state.aliases, aliasKey, canonicalKey);
  ctx.store.append([ev("alias", { alias_key: aliasKey, canonical_key: canonicalKey })]);
}

export function unmergeAlias(ctx, aliasKey, state = ctx.store.state()) {
  if (!state.aliases.has(aliasKey)) throw new PcpError("NOT_FOUND", `No alias for ${aliasKey}.`);
  ctx.store.append([ev("unalias", { alias_key: aliasKey })]);
}
