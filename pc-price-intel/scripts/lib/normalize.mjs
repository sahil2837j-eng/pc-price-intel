// Identity normalizer. Equivalence is achieved by token normalization + sorting, never by
// fuzzy matching. When unsure, SPLIT: a wrong merge is worse than a wrong split.
//
// SAME:      RX6600 = rx6600 8GB = Sapphire Pulse RX6600 8GB = Radeon RX6600
//            i7-4770 = i7 4770 = Intel Core i7 4770       16GB DDR3 = DDR3 16GB
// DIFFERENT: RX580 4GB vs 8GB, GTX1060 3GB vs 6GB, RX6600 vs XT, RTX3060 8GB vs 12GB,
//            RTX3060 vs Ti, DDR3 4GB vs 8GB, DDR3 vs DDR4 16GB, 2x8GB vs 16GB,
//            1TB vs 2TB, i7-4770 vs 4770K
//
// Non-Latin words are ignored: pass the Latin-script model name.

import { loadAsset } from "./paths.mjs";

const CAPACITY_UNITS = new Set(["gb", "mb", "tb"]);

function splitLetterDigit(s) {
  let cur = s;
  for (let i = 0; i < 4; i++) {
    const next = cur.replace(/([a-z])(\d)/g, "$1 $2").replace(/(\d)([a-z])/g, "$1 $2");
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

export function tokenize(rawName, specs) {
  const combined = `${rawName ?? ""} ${specs ?? ""}`.normalize("NFKC").toLowerCase();
  const cleaned = combined.replace(/[^a-z0-9]+/g, " ");
  return splitLetterDigit(cleaned).split(/\s+/).filter(Boolean);
}

/** Merge bundled token lists with per-country extras from config. */
export function tokenLists(config = {}) {
  const t = loadAsset("data/tokens.json");
  const lower = (a) => (a || []).map((w) => String(w).toLowerCase());
  return {
    vendor: new Set([...lower(t.vendor_words), ...lower(config.extra_vendor_words)]),
    subbrand: new Set([...lower(t.subbrand_words), ...lower(config.extra_subbrand_words)]),
    neverDrop: new Set(lower(t.never_drop)),
    capacityRedundant: [...lower(t.capacity_redundant), ...lower(config.extra_capacity_redundant)],
    mbChipsets: lower(t.mb_chipsets),
  };
}

function phraseKey(phrase, lists) {
  return tokenize(phrase, null)
    .filter((w) => !lists.vendor.has(w) && !lists.subbrand.has(w))
    .sort()
    .join(" ");
}

/** key = "<component lowercase>:<sorted space-joined tokens>" */
export function buildKey(component, rawName, specs, config = {}) {
  const lists = tokenLists(config);
  const redundant = lists.capacityRedundant.map((p) => phraseKey(p, lists));

  let tokens = tokenize(rawName, specs).filter(
    (w) => lists.neverDrop.has(w) || (!lists.vendor.has(w) && !lists.subbrand.has(w)),
  );

  // First "<digits> <gb|mb|tb>" pair is the capacity. Keep it unless the base model is in
  // capacity_redundant (e.g. an RX 6600 only ships with 8GB). Never drop a bare number.
  let idx = -1;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (/^\d+$/.test(tokens[i]) && CAPACITY_UNITS.has(tokens[i + 1])) {
      idx = i;
      break;
    }
  }
  if (idx >= 0) {
    const base = [...tokens.slice(0, idx), ...tokens.slice(idx + 2)];
    if (redundant.includes(base.slice().sort().join(" "))) tokens = base;
  }
  return `${component.toLowerCase()}:${tokens.slice().sort().join(" ")}`;
}

/** Seller names normalised so "Al-Noor  Computers" and "al noor computers" count as one seller. */
export function buildSellerKey(seller) {
  if (!seller) return "";
  return seller.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function keyTokens(key) {
  return key.split(":").slice(1).join(":").split(" ").filter(Boolean);
}

export function componentOfKey(key) {
  return key.split(":")[0];
}

/** Jaccard similarity of two keys' tokens (same component only). Display-only suggestions. */
export function keySimilarity(a, b) {
  if (componentOfKey(a) !== componentOfKey(b)) return 0;
  const A = new Set(keyTokens(a));
  const B = new Set(keyTokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function humanizeKey(key) {
  const [component, ...rest] = key.split(":");
  return `${component.toUpperCase()} ${rest.join(":").split(" ").filter(Boolean).map((t) => t.toUpperCase()).join(" ")}`.trim();
}

/**
 * Tokens of a free-text query for matching against stored keys: vendor/sub-brand words
 * removed (same as keys), capacity pairs split out so they can be optional.
 */
export function queryParts(text, config = {}) {
  const lists = tokenLists(config);
  const all = tokenize(text, null).filter((w) => lists.neverDrop.has(w) || (!lists.vendor.has(w) && !lists.subbrand.has(w)));
  const cap = [];
  const others = [];
  for (let i = 0; i < all.length; i++) {
    if (/^\d+$/.test(all[i]) && CAPACITY_UNITS.has(all[i + 1])) {
      cap.push(all[i], all[i + 1]);
      i++;
    } else {
      others.push(all[i]);
    }
  }
  return { others, cap };
}

/** Does a stored key satisfy a free-text query? Capacity only has to match when both sides have one. */
export function keyMatchesQuery(key, parts) {
  const toks = new Set(keyTokens(key));
  if (parts.others.length === 0 && parts.cap.length === 0) return false;
  if (!parts.others.every((t) => toks.has(t))) return false;
  if (parts.cap.length) {
    // Keys are sorted, so check membership (not adjacency). If the key carries a capacity
    // unit, the query's capacity must match it; if the key dropped capacity (redundant
    // models such as RX 6600), a capacity in the query is simply ignored.
    const keyHasCapacity = [...toks].some((t) => CAPACITY_UNITS.has(t));
    if (keyHasCapacity) return parts.cap.every((t) => toks.has(t));
  }
  return true;
}
