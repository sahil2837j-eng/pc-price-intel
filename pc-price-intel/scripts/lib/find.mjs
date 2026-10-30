// "What is the latest price of X?" lookups. Matching is token-based and order-independent
// ("RX 6600" finds the group keyed "6600 rx"); vendor words and capacity are handled like keys.

import { buildKey, keyMatchesQuery, queryParts } from "./normalize.mjs";
import { PcpError } from "./errors.mjs";
import { buildGroups, computeTrend, eligibleRows, latestRow, sortGroups } from "./stats.mjs";

/**
 * @param {object} filters {component, condition, type, level, kind}  type defaults to "asking", kind to "single"
 */
export function findGroups(ctx, state, query, filters = {}) {
  const parts = queryParts(query, ctx.config);
  if (!parts.others.length && !parts.cap.length) {
    throw new PcpError("VALIDATION", "Query has no usable model tokens.", "Pass a model name such as \"RX 6600\" or \"i7 4770\".");
  }
  const comp = filters.component ? String(filters.component).toUpperCase() : null;
  const type = filters.type || "asking";
  const kind = filters.kind || "single";
  const rows = eligibleRows(state, ctx).filter((r) => (!comp || r.component === comp) && r.price_type === type && r.item_kind === kind && (!filters.condition || r.condition === filters.condition) && (!filters.level || r.location_level === filters.level));
  const groups = buildGroups(rows, ctx.config, ctx.today());

  // Exact identity first ("rx 6600" must NOT pull in "rx 6600 xt"); fuzzy only when nothing is exact.
  const comps = comp ? [comp] : [...new Set(groups.map((g) => g.component))];
  const exactKeys = new Set(comps.map((c) => state.resolve(buildKey(c, query, null, ctx.config))));
  let matched = groups.filter((g) => exactKeys.has(g.resolved_key));
  if (!matched.length) matched = groups.filter((g) => keyMatchesQuery(g.resolved_key, parts));
  return sortGroups(matched);
}

export function describeGroup(ctx, g) {
  const latest = latestRow(g.rows);
  const trend = computeTrend(g.rows, ctx.config, ctx.today(), g.label, ctx.profile);
  return {
    group_id: g.id,
    label: g.label,
    resolved_key: g.resolved_key,
    component: g.component,
    condition: g.condition,
    price_type: g.price_type,
    location_level: g.location_level,
    tier: g.tier.tier,
    n: g.tier.n,
    sellers: g.tier.sellers,
    median_minor: g.tier.median_minor,
    median_is_all_time_reference: g.tier.all_time_reference,
    newest_date: g.tier.newest_date,
    needs: g.needs,
    latest: latest
      ? { id: latest.id, price_minor: latest.price_minor, date: latest.observed_date, seller: latest.seller, level: latest.location_level, evidence: latest.evidence }
      : null,
    trend,
  };
}
