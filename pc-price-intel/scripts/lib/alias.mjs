// Alias = a user-confirmed "these two model groups are the same product".
// Resolved at QUERY time (never rewrites stored rows), max 5 hops, cycle-safe, reversible.
// Suggestions are display-only and never applied automatically.

import { PcpError } from "./errors.mjs";
import { keySimilarity } from "./normalize.mjs";

export const MAX_HOPS = 5;

/** @param {Map<string,string>} aliases alias_key -> canonical_key */
export function resolveKey(aliases, key) {
  let cur = key;
  const seen = new Set([cur]);
  for (let i = 0; i < MAX_HOPS; i++) {
    const next = aliases.get(cur);
    if (!next || next === cur) break;
    if (seen.has(next)) break; // cycle: stop resolving
    cur = next;
    seen.add(cur);
  }
  return cur;
}

/** Throws if merging would alias a key to itself or create a cycle. */
export function assertMergeAllowed(aliases, aliasKey, canonicalKey) {
  if (aliasKey === canonicalKey) throw new PcpError("ALIAS_REFUSED", "Cannot alias a group to itself.");
  if (resolveKey(aliases, canonicalKey) === aliasKey) {
    throw new PcpError("ALIAS_REFUSED", "That merge would create a cycle. Refused.", "Unmerge the opposite alias first.");
  }
  const comp = (k) => k.split(":")[0];
  if (comp(aliasKey) !== comp(canonicalKey)) {
    throw new PcpError("ALIAS_REFUSED", "Groups of different components cannot be merged.");
  }
}

/** Display-only: pairs of existing keys that look similar but are not identical. */
export function suggestAliases(keys, aliases, threshold = 0.6, limit = 20) {
  const list = [...new Set(keys)].filter((k) => !aliases.has(k));
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const sim = keySimilarity(list[i], list[j]);
      if (sim >= threshold && sim < 1) out.push({ key_a: list[i], key_b: list[j], similarity: Math.round(sim * 100) / 100 });
    }
  }
  return out.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}
