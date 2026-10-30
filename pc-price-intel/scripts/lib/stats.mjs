// Every number the user sees is computed here, in code. Nothing is estimated or invented.
//
// Eligibility: not voided, not superseded by a correction, not a duplicate, not a bundle,
// sanity ok or user-overridden, in the country's currency, and not a "reference" row.
// Group = (resolved key, item kind, condition, price type, level). Asking/sold, levels,
// conditions and kits-vs-singles are NEVER mixed in one statistic.

import { POSITION_LABEL, TIER_RANK } from "./consts.mjs";
import { humanizeKey } from "./normalize.mjs";
import { daysBetween } from "./timeutil.mjs";
import { fmtMoney, medianMinor } from "./money.mjs";

export function eligibleRows(state, ctx) {
  const superseded = new Set(state.observations.filter((o) => o.correction_of).map((o) => o.correction_of));
  return state.observations
    .filter(
      (o) =>
        !o.voided_at &&
        !superseded.has(o.uuid) &&
        !o.duplicate_of &&
        o.item_kind !== "bundle" &&
        (o.sanity_flag === "ok" || o.sanity_override) &&
        o.currency === ctx.profile.currency &&
        o.evidence !== "reference",
    )
    .map((o) => ({ ...o, resolved_key: state.resolve(o.model_key) }));
}

export function inWindow(date, windowDays, today) {
  const age = daysBetween(date, today);
  return age >= 0 && age < windowDays;
}

export function distinctSellers(rows) {
  const s = new Set();
  for (const r of rows) if (r.seller_key && r.seller_key.trim()) s.add(r.seller_key);
  return s.size;
}

const newest = (rows) => rows.reduce((acc, r) => (acc === null || r.observed_date > acc ? r.observed_date : acc), null);

/**
 * good  = n >= min_samples AND distinct non-empty sellers >= min_sellers AND >= 1 row in window
 * weak  = rows in window but thresholds unmet (display-only)
 * stale = rows only outside the window (all-time reference, labelled)
 * none  = no rows
 */
export function computeTier(rows, cfg, today) {
  if (rows.length === 0) {
    return { tier: "none", n: 0, sellers: 0, median_minor: null, newest_date: null, all_time_reference: false };
  }
  const win = rows.filter((r) => inWindow(r.observed_date, cfg.window_days, today));
  if (win.length === 0) {
    return {
      tier: "stale",
      n: rows.length,
      sellers: distinctSellers(rows),
      median_minor: medianMinor(rows.map((r) => r.price_minor)),
      newest_date: newest(rows),
      all_time_reference: true,
    };
  }
  const n = win.length;
  const sellers = distinctSellers(win);
  const good = n >= cfg.min_samples && sellers >= cfg.min_sellers;
  return {
    tier: good ? "good" : "weak",
    n,
    sellers,
    median_minor: medianMinor(win.map((r) => r.price_minor)),
    newest_date: newest(win),
    all_time_reference: false,
  };
}

export function neededForGood(n, sellers, cfg) {
  const needEntries = Math.max(0, cfg.min_samples - n);
  const needSellers = Math.max(0, cfg.min_sellers - sellers);
  if (!needEntries && !needSellers) return null;
  const parts = [];
  if (needSellers) parts.push(`${needSellers} more seller${needSellers === 1 ? "" : "s"}`);
  if (needEntries > needSellers) parts.push(`${needEntries} more entr${needEntries === 1 ? "y" : "ies"}`);
  return parts.length ? `Needs ${parts.join(" and ")} to reach good tier.` : null;
}

export const groupId = (g) => [g.resolved_key, g.item_kind, g.condition, g.price_type, g.location_level].join("|");

export function buildGroups(rows, cfg, today) {
  const buckets = new Map();
  for (const r of rows) {
    const g = { resolved_key: r.resolved_key, component: r.component, item_kind: r.item_kind, condition: r.condition, price_type: r.price_type, location_level: r.location_level };
    const id = groupId(g);
    if (!buckets.has(id)) buckets.set(id, { ...g, id, rows: [] });
    buckets.get(id).rows.push(r);
  }
  return [...buckets.values()].map((b) => {
    const tier = computeTier(b.rows, cfg, today);
    const { rows: groupRows, ...g } = b;
    return { ...g, label: humanizeKey(g.resolved_key), tier, needs: neededForGood(tier.n, tier.sellers, cfg), rows: groupRows };
  });
}

/** Closest-to-good first, so the user sees what one more entry unlocks. */
export function sortGroups(groups) {
  const gap = (g) => Math.max(0, 3 - g.tier.n) + (g.needs ? 1 : 0);
  return groups.slice().sort((a, b) => TIER_RANK[a.tier.tier] - TIER_RANK[b.tier.tier] || gap(a) - gap(b) || b.tier.n - a.tier.n);
}

/** Price position is only defined for a GOOD tier; otherwise "insufficient data" and no invented median. */
export function pricePosition(priceMinor, tier, bands) {
  if (tier.tier !== "good" || tier.median_minor === null) return { position: "insufficient_data", label: POSITION_LABEL.insufficient_data, ratio: null };
  const ratio = priceMinor / tier.median_minor;
  let position;
  if (ratio <= bands.much_below) position = "much_below";
  else if (ratio < bands.below) position = "below";
  else if (ratio <= bands.above) position = "typical";
  else if (ratio < bands.much_above) position = "above";
  else position = "much_above";
  return { position, label: POSITION_LABEL[position], ratio: Math.round(ratio * 1000) / 1000 };
}

/**
 * cur = last W days, prev = the W days before. Both need >= 2 rows, otherwise "insufficient":
 * no statement, no hypothesis. Direction is "flat" when |change| < trend_flat_pct.
 * The statement is a CODE template, never free text from a model.
 */
export function computeTrend(rows, cfg, today, label, profile) {
  const W = cfg.window_days;
  const age = (r) => daysBetween(r.observed_date, today);
  const cur = rows.filter((r) => age(r) >= 0 && age(r) < W);
  const prev = rows.filter((r) => age(r) >= W && age(r) < 2 * W);
  if (cur.length < 2 || prev.length < 2) {
    return {
      eligible: false,
      reason: `Needs 2 entries in each of the last two ${W}-day windows (has ${cur.length} current / ${prev.length} previous).`,
      cur_n: cur.length,
      prev_n: prev.length,
      cur_median_minor: null,
      prev_median_minor: null,
      change_minor: null,
      change_pct: null,
      direction: null,
      statement: null,
      low_confidence: true,
    };
  }
  const curMed = medianMinor(cur.map((r) => r.price_minor));
  const prevMed = medianMinor(prev.map((r) => r.price_minor));
  const change = curMed - prevMed;
  const pct = prevMed === 0 ? 0 : Math.round((Math.abs(change) / prevMed) * 1000) / 10;
  const direction = pct >= cfg.trend_flat_pct ? (change > 0 ? "up" : "down") : "flat";
  const span = `median ${fmtMoney(prevMed, profile)} -> ${fmtMoney(curMed, profile)}, last ${W} days vs the ${W} before, n=${cur.length} vs ${prev.length}`;
  const statement =
    direction === "flat"
      ? `${label}: roughly flat (${pct}% change; ${span}).`
      : `${label}: median ${direction === "up" ? "rose" : "fell"} ${pct}% (${span}).`;
  return {
    eligible: true,
    cur_n: cur.length,
    prev_n: prev.length,
    cur_median_minor: curMed,
    prev_median_minor: prevMed,
    change_minor: change,
    change_pct: pct,
    direction,
    statement,
    low_confidence: cur.length < 6 || prev.length < 6,
  };
}

export function latestRow(rows) {
  return rows.slice().sort((a, b) => (a.observed_date < b.observed_date ? 1 : a.observed_date > b.observed_date ? -1 : b.id - a.id))[0] || null;
}
