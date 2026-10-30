export const VERSION = "1.0.0";

export const COMPONENTS = ["GPU", "CPU", "RAM", "MOTHERBOARD", "PSU", "SSD", "HDD", "CASE", "COOLER", "OTHER"];
export const ITEM_KINDS = ["single", "kit", "bundle"];
export const PRICE_TYPES = ["asking", "sold"];
export const CONDITIONS = ["new", "used", "refurbished", "unknown"];
// Country-neutral levels. Profiles supply human labels for each.
export const LEVELS = ["local_market", "online_domestic", "other_domestic", "unknown"];
// "reference" rows (foreign currency, benchmarks) are stored but never enter statistics.
export const EVIDENCE = ["observed", "reported", "reference"];

export const DEFAULT_CONFIG = {
  window_days: 30,
  min_samples: 3,
  min_sellers: 2,
  trend_flat_pct: 3.0,
  bands: { much_below: 0.7, below: 0.9, above: 1.1, much_above: 1.3 },
};

export const EXPORT_FORMAT = "pc-price-intel-export";
export const EXPORT_VERSION = 1;
export const APP_EXPORT_FORMAT = "pc-market-watcher-export";

export const TIER_RANK = { good: 0, weak: 1, stale: 2, none: 3 };

export const POSITION_LABEL = {
  much_below: "much below typical",
  below: "below typical",
  typical: "typical",
  above: "above typical",
  much_above: "much above typical",
  insufficient_data: "insufficient data",
};
