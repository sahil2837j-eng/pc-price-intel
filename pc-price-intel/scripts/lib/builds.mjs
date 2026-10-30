// Build totals. A headline total exists ONLY when every part has a good-tier median;
// otherwise it is labelled "partial X/Y" with a known-only subtotal. Asking and sold totals
// are separate. Weak and stale numbers are shown but never summed. Levels are never mixed:
// the in-person level is preferred, then online, and the level used is always reported.

import { loadAsset } from "./paths.mjs";
import { PcpError } from "./errors.mjs";
import { buildKey, keyMatchesQuery, queryParts, humanizeKey } from "./normalize.mjs";
import { buildGroups, computeTier, eligibleRows } from "./stats.mjs";

const LEVEL_PREFERENCE = ["local_market", "online_domestic"];

export function presets() {
  return loadAsset("data/builds.json");
}

export function getPreset(name) {
  const p = presets().presets.find((x) => x.name === String(name).toLowerCase());
  if (!p) throw new PcpError("NOT_FOUND", `No preset "${name}".`, `Available: ${presets().presets.map((x) => x.name).join(", ")}.`);
  return p;
}

function resolvePart(ctx, state, rows, part, condition) {
  const query = part.match || part.hint || part.label;
  const parts = queryParts(query, ctx.config);
  const comp = part.component.toUpperCase();
  const pool = rows.filter((r) => r.component === comp && r.item_kind === "single" && r.condition === condition);
  // Exact identity first, so "rx 6600" never silently becomes "rx 6600 xt".
  const exact = state.resolve(buildKey(comp, query, null, ctx.config));
  const exactHits = pool.filter((r) => r.resolved_key === exact);
  const candidates = exactHits.length ? exactHits : pool.filter((r) => keyMatchesQuery(r.resolved_key, parts));
  const keys = new Map();
  for (const r of candidates) keys.set(r.resolved_key, (keys.get(r.resolved_key) || 0) + 1);
  if (!keys.size) return { key: null, alternatives: [] };
  const ranked = [...keys.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return { key: ranked[0], alternatives: ranked.slice(1).map(humanizeKey) };
}

function priceFor(ctx, rows, key, condition, priceType) {
  const today = ctx.today();
  const attempts = LEVEL_PREFERENCE.map((level) => {
    const lv = rows.filter((r) => r.resolved_key === key && r.item_kind === "single" && r.condition === condition && r.price_type === priceType && r.location_level === level);
    return { level, tier: computeTier(lv, ctx.config, today) };
  });
  const good = attempts.find((a) => a.tier.tier === "good");
  if (good) return good;
  const best = attempts.filter((a) => a.tier.n > 0).sort((a, b) => b.tier.n - a.tier.n)[0];
  return best || { level: null, tier: computeTier([], ctx.config, today) };
}

/**
 * @param {{name?:string, condition:string, parts:{component:string,label?:string,hint?:string,match?:string,qty?:number}[]}} spec
 */
export function buildTotals(ctx, state, spec) {
  const rows = eligibleRows(state, ctx);
  const results = spec.parts.map((part) => {
    const qty = part.qty && part.qty > 0 ? Math.floor(part.qty) : 1;
    const { key, alternatives } = resolvePart(ctx, state, rows, part, spec.condition);
    if (!key) {
      return { component: part.component, label: part.label || part.hint, match: part.match || part.hint, matched: null, alternatives: [], qty, asking: null, sold: null };
    }
    return {
      component: part.component,
      label: part.label || part.hint,
      match: part.match || part.hint,
      matched: humanizeKey(key),
      matched_key: key,
      alternatives,
      qty,
      asking: priceFor(ctx, rows, key, spec.condition, "asking"),
      sold: priceFor(ctx, rows, key, spec.condition, "sold"),
    };
  });

  const total = (kind) => {
    let subtotal = 0;
    let known = 0;
    for (const p of results) {
      const t = p[kind];
      if (t && t.tier.tier === "good" && t.tier.median_minor !== null) {
        subtotal += t.tier.median_minor * p.qty;
        known++;
      }
    }
    const all = results.length > 0 && known === results.length;
    return {
      kind,
      all_good: all,
      priced: known,
      parts: results.length,
      subtotal_minor: subtotal,
      label: all
        ? `estimated ${kind} total (last ${ctx.config.window_days} days)`
        : `partial ${known}/${results.length} priced: known-only subtotal`,
    };
  };

  return { name: spec.name || "custom", condition: spec.condition, parts: results, asking_total: total("asking"), sold_total: total("sold") };
}

export function allGroupsCount(ctx, state) {
  return buildGroups(eligibleRows(state, ctx), ctx.config, ctx.today()).length;
}
