// Deal checker: price position (only when the tier is GOOD) + risk keywords with verbatim
// quotes + the in-person checklist + the fixed disclaimer. It never says "good deal",
// "scam", "safe" or "genuine". Levels are never mixed: without --level, each level that has
// data gets its own line.

import { TIER_RANK } from "./consts.mjs";
import { buildKey, humanizeKey } from "./normalize.mjs";
import { loadAsset } from "./paths.mjs";
import { computeTier, eligibleRows, neededForGood, pricePosition } from "./stats.mjs";

export function scanRiskTerms(text, terms) {
  if (!text) return [];
  const norm = String(text).toLowerCase().replace(/\s+/g, " ");
  const hits = [];
  for (const { term, severity } of terms) {
    const needle = term.toLowerCase().replace(/\s+/g, " ");
    const idx = norm.indexOf(needle);
    if (idx >= 0) {
      hits.push({ term, severity, quote: norm.slice(Math.max(0, idx - 20), Math.min(norm.length, idx + needle.length + 20)).trim() });
    }
  }
  return hits;
}

export function checklistFor(component) {
  const c = loadAsset("data/checklists.json");
  return c.components[component] || c.components.OTHER;
}

export function dealCheck(ctx, state, input) {
  const component = String(input.component).toUpperCase();
  const key = buildKey(component, input.name, null, ctx.config);
  const resolved = state.resolve(key);
  const today = ctx.today();
  const rows = eligibleRows(state, ctx).filter(
    (r) => r.resolved_key === resolved && r.item_kind === "single" && r.condition === input.condition && r.price_type === "asking" && (!input.level || r.location_level === input.level),
  );

  const levels = input.level ? [input.level] : [...new Set(rows.map((r) => r.location_level))];
  const byLevel = (levels.length ? levels : [input.level || "unknown"]).map((level) => {
    const lvRows = rows.filter((r) => r.location_level === level);
    const tier = computeTier(lvRows, ctx.config, today);
    const pos = pricePosition(input.price_minor, tier, ctx.config.bands);
    return {
      level,
      tier: tier.tier,
      n: tier.n,
      sellers: tier.sellers,
      // A median is only exposed when the tier is good; otherwise there is no number to show.
      median_minor: tier.tier === "good" ? tier.median_minor : null,
      position: pos.position,
      position_label: pos.label,
      ratio: pos.ratio,
      needs: neededForGood(tier.n, tier.sellers, ctx.config),
      insufficient_note:
        tier.tier === "good" ? null : `Insufficient data: need ${ctx.config.min_samples} entries from ${ctx.config.min_sellers} sellers; you have ${tier.n} from ${tier.sellers}.`,
    };
  });
  byLevel.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.n - a.n);

  const checks = loadAsset("data/checklists.json");
  const risk = [...loadAsset("data/risk-terms.json"), ...(ctx.config.extra_risk_terms || [])];
  return {
    label: humanizeKey(resolved),
    resolved_key: resolved,
    by_level: byLevel,
    risk_hits: scanRiskTerms(input.text, risk),
    checklist: checklistFor(component),
    price_quality_caution: checks.caution_components.includes(component) ? checks.caution_text : null,
    test_before_pay: checks.test_before_pay,
    disclaimer: checks.disclaimer,
  };
}
