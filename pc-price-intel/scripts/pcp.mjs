#!/usr/bin/env node
// pcp: the PC Price Intel command line. Zero dependencies, no network access, Node >= 18.
// Agents: always pass --json. Run `pcp help` for the command list.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertMergeAllowed, resolveKey, suggestAliases } from "./lib/alias.mjs";
import { buildTotals, getPreset, presets } from "./lib/builds.mjs";
import { candidatesFromText, addCandidates, confirmCandidate, discardCandidate } from "./lib/candidates.mjs";
import { resetConfig, setConfigValue, setSanity } from "./lib/config.mjs";
import { COMPONENTS, CONDITIONS, VERSION } from "./lib/consts.mjs";
import { activeCountry, makeContext, resolveCountryCode, setActiveCountry } from "./lib/context.mjs";
import { dealCheck, checklistFor } from "./lib/deal.mjs";
import { PcpError } from "./lib/errors.mjs";
import { htmlToText } from "./lib/extract.mjs";
import { describeGroup, findGroups } from "./lib/find.mjs";
import { table } from "./lib/format.mjs";
import { currencyDecimals, fmtMoney, parsePriceInput, toMinor } from "./lib/money.mjs";
import { buildKey, humanizeKey } from "./lib/normalize.mjs";
import {
  chainOf, correctObservation, logObservation, mergeAlias, overrideSanity,
  rowStatus, unmarkDuplicate, unmergeAlias, unvoidObservation, voidObservation,
} from "./lib/observations.mjs";
import { countryDir, dataRoot, ensureDir, loadAsset } from "./lib/paths.mjs";
import { listCountries, loadProfile, normalizeCountryCode, saveUserProfile } from "./lib/profiles.mjs";
import { buildGroups, eligibleRows, sortGroups } from "./lib/stats.mjs";
import { ageLabel, fmtDate, isoUtc } from "./lib/timeutil.mjs";
import { analyzeImport, appToPcp, applyImport, exportData, pcpToApp } from "./lib/transfer.mjs";

// ---------------------------------------------------------------- argv
const BOOL = new Set(["json", "confirm", "settings", "force", "help", "all", "queue", "voided", "duplicates", "flagged", "from-app", "as-app", "stdin", "compat", "preview", "list", "off"]);
const MULTI = new Set(["set"]);

export function parseArgv(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let val;
      if (eq !== -1) val = a.slice(eq + 1);
      else if (BOOL.has(key)) val = true;
      else {
        val = argv[++i];
        if (val === undefined) throw new PcpError("USAGE", `--${key} needs a value.`);
      }
      if (MULTI.has(key)) (flags[key] ||= []).push(val);
      else flags[key] = val;
    } else pos.push(a);
  }
  return { pos, flags };
}

// ---------------------------------------------------------------- helpers
let ACTIVE_PROFILE = null;
/** Build the context and remember its profile so JSON output can add ready-to-quote money text. */
function ctxOf(flags) {
  const c = makeContext(flags);
  ACTIVE_PROFILE = c.profile;
  return c;
}

/** Every `x_minor` integer gets an `x_text` sibling ("PKR 46,000") so agents never convert units themselves. */
function addMoneyText(node, profile) {
  if (Array.isArray(node)) return node.forEach((n) => addMoneyText(n, profile));
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (k.endsWith("_minor") && typeof v === "number") {
      const cur = typeof node.currency === "string" ? node.currency : profile.currency;
      const decimals = cur === profile.currency ? profile.decimals : currencyDecimals(cur);
      node[k.replace(/_minor$/, "_text")] = fmtMoney(v, { currency: cur, decimals, locale: profile.locale });
    } else addMoneyText(v, profile);
  }
}

const money = (ctx, minor) => fmtMoney(minor, ctx.profile);
const requireFlag = (flags, name, hint) => {
  if (flags[name] === undefined || flags[name] === "") throw new PcpError("USAGE", `--${name} is required.`, hint);
  return flags[name];
};

function priceToMinor(ctx, raw) {
  const major = parsePriceInput(raw, ctx.profile);
  if (!(major > 0)) throw new PcpError("VALIDATION", "Price must be greater than 0.");
  return toMinor(major, ctx.profile.decimals);
}

function readText(flags) {
  if (flags.text) return String(flags.text);
  if (flags.file) return fs.readFileSync(String(flags.file), "utf8");
  if (flags.stdin) return fs.readFileSync(0, "utf8");
  throw new PcpError("USAGE", "Provide --text \"...\", --file path, or --stdin.");
}

const looksHtml = (s) => /<(html|div|span|p|body|table|ul|li|a)\b[^>]*>/i.test(s);

function groupFeedback(ctx, event) {
  const state = ctx.store.state();
  const rows = eligibleRows(state, ctx);
  const resolved = state.resolve(event.model_key);
  const g = buildGroups(rows, ctx.config, ctx.today()).find(
    (x) => x.resolved_key === resolved && x.item_kind === event.item_kind && x.condition === event.condition && x.price_type === event.price_type && x.location_level === event.location_level,
  );
  if (!g) return null;
  return { group_id: g.id, label: g.label, tier: g.tier.tier, n: g.tier.n, sellers: g.tier.sellers, median_minor: g.tier.median_minor, needs: g.needs };
}

const slimRow = (o, superseded) => ({
  id: o.id, uuid: o.uuid, date: o.observed_date, component: o.component, name: o.raw_name, model_key: o.model_key, kind: o.item_kind,
  price_minor: o.price_minor, currency: o.currency, type: o.price_type, condition: o.condition, seller: o.seller, location: o.location, level: o.location_level,
  evidence: o.evidence, sanity_flag: o.sanity_flag, sanity_override: o.sanity_override, status: rowStatus(o, superseded), notes: o.notes,
});

// ---------------------------------------------------------------- commands
const C = {};

C.help = () => ({ data: { commands: Object.keys(C).filter((k) => k !== "help") }, text: HELP });

C.version = () => ({ data: { version: VERSION }, text: `pcp ${VERSION}` });

C.doctor = ({ flags }) => {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add("node >= 18", Number(process.versions.node.split(".")[0]) >= 18, process.version);
  try {
    new Intl.DateTimeFormat("en", { timeZone: "Asia/Karachi" });
    add("Intl time zones", true, "ok");
  } catch {
    add("Intl time zones", false, "this Node build lacks full ICU; time zones will not work");
  }
  const root = dataRoot();
  try {
    ensureDir(root);
    const probe = path.join(root, `.probe-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe);
    add("data dir writable", true, root);
  } catch (e) {
    add("data dir writable", false, `${root}: ${e.message}`);
  }
  const cc = flags.country || process.env.PCP_COUNTRY || activeCountry();
  add("country set", Boolean(cc), cc || "none: run `pcp init --country <ISO>`");
  if (cc) {
    try {
      const ctx = ctxOf(flags);
      const st = ctx.store.state();
      add("profile loads", true, `${ctx.profile.country} ${ctx.profile.currency} ${ctx.tz} (${ctx.profile.source})`);
      add("event log readable", true, `${st.observations.length} observations${st.warnings.length ? `; warnings: ${st.warnings.join(" ")}` : ""}`);
    } catch (e) {
      add("profile/log", false, e.message);
    }
  }
  const ok = checks.every((c) => c.ok || c.name === "country set");
  return { data: { healthy: ok, version: VERSION, checks }, text: checks.map((c) => `${c.ok ? "ok " : "!! "} ${c.name}: ${c.detail}`).join("\n") };
};

C.country = ({ pos, flags }) => {
  const sub = pos[1] || "list";
  if (sub === "list") {
    const rows = listCountries();
    return { data: { active: activeCountry(), countries: rows }, text: table(rows, [{ label: "CC", key: "cc" }, { label: "Country", key: "name" }, { label: "Currency", key: "currency" }, { label: "Time zone", key: "timezone" }, { label: "Rich profile", get: (r) => (r.rich_profile || r.user_profile ? "yes" : "no") }]) + "\nAny other country works: pcp init --country XX --currency ISO4217 --tz Area/City" };
  }
  if (sub === "show") {
    const cc = pos[2] ? normalizeCountryCode(pos[2]) : resolveCountryCode(flags);
    const profile = loadProfile(cc, { currency: flags.currency, tz: flags.tz });
    return { data: { profile }, text: JSON.stringify(profile, null, 2) };
  }
  throw new PcpError("USAGE", "Usage: pcp country list | pcp country show [CC]");
};

C.init = ({ flags }) => {
  const cc = normalizeCountryCode(requireFlag(flags, "country", "e.g. pcp init --country PK"));
  const profile = loadProfile(cc, { currency: flags.currency, tz: flags.tz });
  const known = listCountries().some((c) => c.cc === cc);
  if (!known || flags.currency || flags.tz) {
    saveUserProfile({ country: cc, label: flags.label || profile.label, currency: profile.currency, timezone: profile.timezone });
  }
  ensureDir(countryDir(cc));
  setActiveCountry(cc);
  if (flags.market) setConfigValue(cc, "home_market", flags.market);
  const p = loadProfile(cc);
  const data = {
    active_country: cc,
    label: p.label,
    currency: p.currency,
    decimals: p.decimals,
    timezone: p.timezone,
    tz_note: p.tz_note,
    profile_source: p.source,
    verified: p.verified,
    markets: p.markets,
    online_sources: p.online_sources,
    local_terms: p.local_terms,
    search_queries: p.search_queries,
    has_sanity_ranges: Object.keys(p.sanity || {}).length > 0,
    notes: p.notes,
    next_steps: [
      "Tell the user which market is active (country, currency, home market).",
      p.source === "generated" ? "No curated market data for this country: research local sources live, cite them, then `pcp profile import` a profile file (see assets/profiles/_template.json)." : "Profile facts are starting points (verified: " + p.verified + "). Re-check sources live before relying on them.",
      "Log prices with `pcp log` (always pass --type, --condition, --level).",
    ],
  };
  return { data, text: `Active market: ${p.label} (${cc}) · ${p.currency} · ${p.timezone}${p.tz_note ? `\n  note: ${p.tz_note}` : ""}\nProfile: ${p.source}${p.verified ? "" : " (unverified starting point)"}\n${p.notes.map((n) => `- ${n}`).join("\n")}` };
};

C.status = ({ flags }) => {
  const ctx = ctxOf(flags);
  const st = ctx.store.state();
  const rows = eligibleRows(st, ctx);
  const groups = buildGroups(rows, ctx.config, ctx.today());
  const newest = st.observations.reduce((a, o) => (!a || o.observed_date > a ? o.observed_date : a), null);
  const data = {
    country: ctx.cc, label: ctx.profile.label, currency: ctx.profile.currency, decimals: ctx.profile.decimals, timezone: ctx.tz, today: ctx.today(),
    home_market: ctx.config.home_market, profile_source: ctx.profile.source, profile_verified: ctx.profile.verified,
    data_dir: countryDir(ctx.cc), observations: st.observations.length, eligible: rows.length,
    groups: groups.length, good_groups: groups.filter((g) => g.tier.tier === "good").length,
    pending_candidates: st.candidates.filter((c) => c.status === "pending").length,
    newest_entry: newest, newest_entry_age: newest ? ageLabel(newest, ctx.today()) : "no data", warnings: st.warnings,
    config: { window_days: ctx.config.window_days, min_samples: ctx.config.min_samples, min_sellers: ctx.config.min_sellers, trend_flat_pct: ctx.config.trend_flat_pct, bands: ctx.config.bands },
  };
  return { data, text: [`Market: ${data.label} (${data.country}) · ${data.currency} · ${data.timezone} · today ${data.today}`, `Entries: ${data.observations} (${data.eligible} eligible) · groups ${data.groups} (${data.good_groups} good) · newest ${data.newest_entry_age}`, `Pending candidates: ${data.pending_candidates}`, ...data.warnings.map((w) => `warning: ${w}`)].join("\n") };
};

C.profile = ({ pos, flags }) => {
  const sub = pos[1] || "show";
  if (sub === "show" || sub === "export") {
    const ctx = ctxOf(flags);
    return { data: { profile: ctx.profile }, text: JSON.stringify(ctx.profile, null, 2) };
  }
  if (sub === "import") {
    const file = pos[2];
    if (!file) throw new PcpError("USAGE", "Usage: pcp profile import <file.json>");
    const saved = saveUserProfile(JSON.parse(fs.readFileSync(file, "utf8")));
    return { data: { saved: saved.country, path: path.join(dataRoot(), "profiles", `${saved.country}.json`) }, text: `Saved profile for ${saved.country}.` };
  }
  throw new PcpError("USAGE", "Usage: pcp profile show | export | import <file>");
};

C.config = ({ pos, flags }) => {
  const sub = pos[1] || "show";
  const cc = resolveCountryCode(flags);
  if (sub === "show") {
    const ctx = ctxOf(flags);
    return { data: { config: ctx.config }, text: JSON.stringify(ctx.config, null, 2) };
  }
  if (sub === "set") {
    if (!pos[2] || pos[3] === undefined) throw new PcpError("USAGE", "Usage: pcp config set <key> <value>");
    setConfigValue(cc, pos[2], pos.slice(3).join(" "));
    return { data: { set: pos[2] }, text: `Set ${pos[2]}.` };
  }
  if (sub === "sanity") {
    if (pos.length < 5) throw new PcpError("USAGE", "Usage: pcp config sanity <COMPONENT> <min> <max>  (major units; a flag range, not a price claim)");
    setSanity(cc, pos[2], pos[3], pos[4]);
    return { data: { sanity: pos[2].toUpperCase(), min: Number(pos[3]), max: Number(pos[4]) }, text: `Sanity range for ${pos[2].toUpperCase()} set (sanity range, not a price claim).` };
  }
  if (sub === "reset") {
    resetConfig(cc, pos[2]);
    return { data: { reset: pos[2] || "all" }, text: `Reset ${pos[2] || "all overrides"}.` };
  }
  throw new PcpError("USAGE", "Usage: pcp config show | set <key> <value> | sanity <COMP> <min> <max> | reset [key]");
};

C.log = ({ flags }) => {
  const ctx = ctxOf(flags);
  const res = logObservation(ctx, flags);
  const e = res.event;
  const feedback = res.reference_only || e.duplicate_of ? null : groupFeedback(ctx, e);
  const lines = [`● Saved #${e.id} — ${e.component} · ${e.condition} · ${e.price_type} · ${money(ctx, e.price_minor)} · ${e.location_level} · ${fmtDate(e.observed_date)}`];
  if (res.reference_only) lines.push(`ℹ Stored as a reference row (${e.currency}); it never enters statistics.`);
  if (e.sanity_flag !== "ok") lines.push(`⚠ Flagged ${e.sanity_flag} for ${e.component} (sanity range, not a price claim). Override with: pcp override ${e.id}`);
  if (e.duplicate_of) lines.push(`⚠ Possible duplicate of #${res.duplicate_of_row.id} (same seller, same price, within 1 day). Unmark with: pcp unmark-dup ${e.id}`);
  if (e.item_kind === "bundle") lines.push("ℹ Bundles never enter statistics.");
  if (feedback) lines.push(`This group now has ${feedback.n} entr${feedback.n === 1 ? "y" : "ies"} from ${feedback.sellers} seller${feedback.sellers === 1 ? "" : "s"} — tier: ${feedback.tier}.${feedback.median_minor !== null ? ` Median ${e.price_type}: ${money(ctx, feedback.median_minor)}.` : ""} ${feedback.needs ?? ""}`.trim());
  return { data: { record: slimRow(e, new Set()), duplicate_of: e.duplicate_of, reference_only: res.reference_only, group: feedback }, text: lines.join("\n") };
};

C.list = ({ flags }) => {
  const ctx = ctxOf(flags);
  const st = ctx.store.state();
  const superseded = new Set(st.observations.filter((o) => o.correction_of).map((o) => o.correction_of));
  let rows = st.observations.map((o) => slimRow(o, superseded));
  const f = (v) => (v === undefined ? null : String(v).toLowerCase());
  if (flags.component) rows = rows.filter((r) => r.component === String(flags.component).toUpperCase());
  if (flags.model) { const m = f(flags.model); rows = rows.filter((r) => r.model_key.includes(m) || r.name.toLowerCase().includes(m)); }
  if (flags.seller) { const s = f(flags.seller); rows = rows.filter((r) => (r.seller || "").toLowerCase().includes(s)); }
  if (flags.level) rows = rows.filter((r) => r.level === f(flags.level));
  if (flags.condition) rows = rows.filter((r) => r.condition === f(flags.condition));
  if (flags.type) rows = rows.filter((r) => r.type === f(flags.type));
  if (flags.from) rows = rows.filter((r) => r.date >= flags.from);
  if (flags.to) rows = rows.filter((r) => r.date <= flags.to);
  if (!flags.voided) rows = rows.filter((r) => r.status !== "voided");
  if (!flags.duplicates) rows = rows.filter((r) => r.status !== "duplicate");
  if (flags.flagged) rows = rows.filter((r) => r.sanity_flag !== "ok");
  rows.sort((a, b) => b.id - a.id);
  const limit = Math.min(Number(flags.limit) || 20, 50);
  const page = Math.max(Number(flags.page) || 1, 1);
  const paged = rows.slice((page - 1) * limit, page * limit);
  return { data: { total: rows.length, page, limit, rows: paged }, text: table(paged, [{ label: "#", key: "id" }, { label: "Date", key: "date" }, { label: "Comp", key: "component" }, { label: "Model", key: "name" }, { label: "Price", get: (r) => money(ctx, r.price_minor) }, { label: "Type", key: "type" }, { label: "Cond", key: "condition" }, { label: "Seller", get: (r) => r.seller || "—" }, { label: "Level", key: "level" }, { label: "Status", key: "status" }]) + `\n${rows.length} total · page ${page}` };
};

C.correct = ({ pos, flags }) => {
  const ctx = ctxOf(flags);
  const res = correctObservation(ctx, requireFlag({ ref: pos[1] }, "ref", "Usage: pcp correct <id|uuid> [--price N ...]"), flags);
  return { data: { record: slimRow(res.event, new Set()), corrects: res.original.id }, text: `● Saved correction #${res.event.id} of #${res.original.id}. The original is unchanged and now ineligible.` };
};
C.void = ({ pos, flags }) => {
  const ctx = ctxOf(flags);
  const o = voidObservation(ctx, requireFlag({ ref: pos[1] }, "ref", "Usage: pcp void <id> --reason \"...\""), flags.reason);
  return { data: { voided: o.id }, text: `● Voided #${o.id} (soft; undo with: pcp unvoid ${o.id}).` };
};
C.unvoid = ({ pos, flags }) => {
  const o = unvoidObservation(ctxOf(flags), pos[1]);
  return { data: { unvoided: o.id }, text: `● Unvoided #${o.id}.` };
};
C["unmark-dup"] = ({ pos, flags }) => {
  const o = unmarkDuplicate(ctxOf(flags), pos[1]);
  return { data: { unmarked: o.id }, text: `● #${o.id} is no longer marked as a duplicate.` };
};
C.override = ({ pos, flags }) => {
  const o = overrideSanity(ctxOf(flags), pos[1], flags.off ? false : true);
  return { data: { overridden: o.id }, text: `● Sanity override set on #${o.id} (user verified this price).` };
};
C.chain = ({ pos, flags }) => {
  const ctx = ctxOf(flags);
  const st = ctx.store.state();
  const superseded = new Set(st.observations.filter((o) => o.correction_of).map((o) => o.correction_of));
  const chain = chainOf(st, pos[1]).map((o) => slimRow(o, superseded));
  return { data: { chain }, text: chain.map((r) => `#${r.id} ${money(ctx, r.price_minor)} ${r.date} (${r.status})`).join("\n  -> ") };
};

C.groups = ({ flags }) => {
  const ctx = ctxOf(flags);
  const st = ctx.store.state();
  let groups = buildGroups(eligibleRows(st, ctx), ctx.config, ctx.today());
  if (flags.component) groups = groups.filter((g) => g.component === String(flags.component).toUpperCase());
  if (flags.level) groups = groups.filter((g) => g.location_level === flags.level);
  if (flags.condition) groups = groups.filter((g) => g.condition === flags.condition);
  if (flags.type) groups = groups.filter((g) => g.price_type === flags.type);
  const out = sortGroups(groups).map((g) => ({ group_id: g.id, label: g.label, resolved_key: g.resolved_key, condition: g.condition, price_type: g.price_type, location_level: g.location_level, tier: g.tier.tier, n: g.tier.n, sellers: g.tier.sellers, median_minor: g.tier.median_minor, median_is_all_time_reference: g.tier.all_time_reference, newest_date: g.tier.newest_date, needs: g.needs }));
  return { data: { groups: out }, text: table(out, [{ label: "Group", key: "label" }, { label: "Cond", key: "condition" }, { label: "Type", key: "price_type" }, { label: "Level", key: "location_level" }, { label: "n", key: "n" }, { label: "Sellers", key: "sellers" }, { label: "Median", get: (g) => (g.tier === "good" ? money(ctx, g.median_minor) : g.median_minor !== null ? `${money(ctx, g.median_minor)} (ref, ${g.tier})` : "no data") }, { label: "Tier", key: "tier" }, { label: "Needs", get: (g) => g.needs || "—" }]) };
};

function renderGroup(ctx, d) {
  const lines = [`${d.label} · ${d.condition} · ${d.price_type} · ${d.location_level}`];
  lines.push(`  tier: ${d.tier} (n=${d.n}, sellers=${d.sellers}) · median ${d.tier === "good" ? money(ctx, d.median_minor) : d.median_minor !== null ? `${money(ctx, d.median_minor)} (reference only, tier ${d.tier})` : "no data"} · newest ${d.newest_date ? ageLabel(d.newest_date, ctx.today()) : "no data"}`);
  if (d.latest) lines.push(`  latest entry: ${money(ctx, d.latest.price_minor)} on ${fmtDate(d.latest.date)}${d.latest.seller ? ` from ${d.latest.seller}` : ""} (#${d.latest.id})`);
  if (d.trend.eligible) lines.push(`  trend: ${d.trend.statement}${d.trend.low_confidence ? " Early data is mostly noise (fewer than 6 entries in a window)." : ""}`);
  else lines.push(`  trend: insufficient data. ${d.trend.reason}`);
  if (d.needs) lines.push(`  ${d.needs}`);
  return lines.join("\n");
}

C.latest = ({ pos, flags }) => {
  const ctx = ctxOf(flags);
  const query = pos.slice(1).join(" ");
  if (!query) throw new PcpError("USAGE", "Usage: pcp latest \"<model>\" [--component GPU --condition used --type asking --level local_market]");
  const st = ctx.store.state();
  const groups = findGroups(ctx, st, query, flags).map((g) => describeGroup(ctx, g));
  return { data: { query, matches: groups, note: groups.length ? "Quote the tier word with every number. A non-good median is a reference, not the price." : "No logged group matches. Say so; do not guess a price." }, text: groups.length ? groups.map((d) => renderGroup(ctx, d)).join("\n\n") : `No logged group matches "${query}" (no data, not zero).` };
};

C.trend = ({ pos, flags }) => {
  const ctx = ctxOf(flags);
  const st = ctx.store.state();
  let groups;
  if (flags.group) {
    const all = buildGroups(eligibleRows(st, ctx), ctx.config, ctx.today());
    groups = all.filter((g) => g.id === flags.group);
    if (!groups.length) throw new PcpError("NOT_FOUND", `No group ${flags.group}.`, "List ids with `pcp groups --json`.");
  } else {
    const query = pos.slice(1).join(" ");
    if (!query) throw new PcpError("USAGE", "Usage: pcp trend \"<model>\" | pcp trend --group <group_id>");
    groups = findGroups(ctx, st, query, flags);
  }
  const out = groups.map((g) => describeGroup(ctx, g));
  return { data: { trends: out.map((d) => ({ group_id: d.group_id, label: d.label, trend: d.trend, latest: d.latest })) }, text: out.length ? out.map((d) => renderGroup(ctx, d)).join("\n\n") : "No matching group." };
};

C.deal = ({ flags }) => {
  const ctx = ctxOf(flags);
  const component = String(requireFlag(flags, "component")).toUpperCase();
  if (!COMPONENTS.includes(component)) throw new PcpError("VALIDATION", `component must be one of ${COMPONENTS.join(", ")}.`);
  const name = requireFlag(flags, "name");
  const condition = String(requireFlag(flags, "condition", "Ask the user: new, used, refurbished or unknown?")).toLowerCase();
  if (!CONDITIONS.includes(condition)) throw new PcpError("VALIDATION", `condition must be one of ${CONDITIONS.join(", ")}.`);
  const text = flags["text-file"] ? fs.readFileSync(String(flags["text-file"]), "utf8") : flags.text;
  const r = dealCheck(ctx, ctx.store.state(), { component, name, price_minor: priceToMinor(ctx, requireFlag(flags, "price")), condition, level: flags.level, text });
  const lines = [`Deal check: ${r.label} · ${condition} · asking ${money(ctx, priceToMinor(ctx, flags.price))}`, "1) Price position"];
  for (const l of r.by_level) lines.push(`   [${l.level}] ${l.tier === "good" ? `${l.position_label} (ratio ${l.ratio} of median ${money(ctx, l.median_minor)}; n=${l.n}, sellers=${l.sellers})` : l.insufficient_note}`);
  if (r.price_quality_caution) lines.push(`   ${r.price_quality_caution}`);
  lines.push("2) Risk indicators", ...(r.risk_hits.length ? r.risk_hits.map((h) => `   ⚠ [${h.severity}] "${h.term}": “…${h.quote}…”`) : ["   none found in the supplied text"]), "3) In-person checklist", ...r.checklist.map((c) => `   - ${c}`), `   ${r.test_before_pay}`, `4) ${r.disclaimer}`);
  return { data: { ...r, price_minor: priceToMinor(ctx, flags.price) }, text: lines.join("\n") };
};

C.extract = ({ flags }) => {
  const ctx = ctxOf(flags);
  let text = readText(flags);
  if (looksHtml(text)) text = htmlToText(text);
  const res = candidatesFromText(ctx, { text, source: flags.source || "extract", url: flags.url, name: flags.name, component: flags.component, pattern: flags.pattern, queue: Boolean(flags.queue) });
  return {
    data: { name: res.name, found: res.found, queued_ids: res.queued_ids, note: "Prices were found verbatim in the text. Nothing is in statistics until you confirm candidates." },
    text: res.found.length ? res.found.map((f) => `${f.currency} ${f.value.toLocaleString("en")} — “${f.quote}”`).join("\n") + (flags.queue ? `\nQueued ${res.queued_ids.length} candidate(s).` : "\n(not queued; add --queue)") : "No price found in the text (price not found; nothing invented).",
  };
};

C.candidates = ({ pos, flags }) => {
  const ctx = ctxOf(flags);
  const sub = pos[1] || "list";
  const st = ctx.store.state();
  if (sub === "list") {
    const status = flags.status || "pending";
    const rows = st.candidates.filter((c) => c.status === status);
    return { data: { status, rows }, text: table(rows, [{ label: "#", key: "id" }, { label: "Source", key: "source" }, { label: "Model", key: "raw_name" }, { label: "Price", get: (c) => { const dec = currencyDecimals(c.currency); return c.currency === ctx.profile.currency ? money(ctx, c.price_minor) : `${c.currency} ${(c.price_minor / 10 ** dec).toFixed(dec)} (reference)`; } }, { label: "Seller", get: (c) => c.seller || "—" }, { label: "Quote", get: (c) => (c.quote || "").slice(0, 50) }]) };
  }
  if (sub === "add") {
    const items = [];
    if (flags.file) {
      const arr = JSON.parse(fs.readFileSync(String(flags.file), "utf8"));
      for (const r of Array.isArray(arr) ? arr : arr.candidates || []) items.push(r);
    } else items.push({ name: requireFlag(flags, "name"), price: requireFlag(flags, "price"), currency: flags.currency, component: flags.component, type: flags.type, condition: flags.condition, quote: flags.quote, url: flags.url });
    const inputs = items.map((r) => {
      const cur = String(r.currency || ctx.profile.currency).toUpperCase();
      const dec = cur === ctx.profile.currency ? ctx.profile.decimals : new Intl.NumberFormat("en", { style: "currency", currency: cur }).resolvedOptions().maximumFractionDigits;
      const major = typeof r.price === "number" ? r.price : parsePriceInput(r.price, ctx.profile);
      return { source: flags.source || r.source || "agent", source_url: r.url || r.source_url, component: r.component, raw_name: r.name || r.raw_name, price_minor: toMinor(major, dec), currency: cur, price_type: r.type || r.price_type, condition: r.condition, seller: r.seller, location: r.location, evidence: r.evidence, level: r.level, quote: r.quote };
    });
    const ids = addCandidates(ctx, inputs, st);
    return { data: { queued_ids: ids }, text: `Queued ${ids.length} candidate(s). A human must confirm them.` };
  }
  if (sub === "confirm") {
    const res = confirmCandidate(ctx, pos[2], { component: flags.component, type: flags.type, condition: flags.condition, level: flags.level, date: flags.date, name: flags.name, seller: flags.seller, location: flags.location, evidence: flags.evidence }, st);
    const kind = res.event.evidence === "reference" ? "reference" : "reported";
    return { data: { record: slimRow(res.event, new Set()) }, text: `● Confirmed → saved #${res.event.id} as ${kind} / ${res.event.location_level}.` };
  }
  if (sub === "discard") {
    const c = discardCandidate(ctx, pos[2], st);
    return { data: { discarded: c.id }, text: `Discarded candidate ${c.id}.` };
  }
  throw new PcpError("USAGE", "Usage: pcp candidates list | add | confirm <id> | discard <id>");
};

C.alias = ({ pos, flags }) => {
  const ctx = ctxOf(flags);
  const st = ctx.store.state();
  const sub = pos[1] || "list";
  if (sub === "list") return { data: { aliases: [...st.aliases].map(([alias_key, canonical_key]) => ({ alias_key, canonical_key })) }, text: [...st.aliases].map(([a, c]) => `${a} -> ${c}`).join("\n") || "(none)" };
  if (sub === "suggest") {
    const keys = st.observations.map((o) => o.model_key);
    const s = suggestAliases(keys, st.aliases).map((x) => ({ ...x, label_a: humanizeKey(x.key_a), label_b: humanizeKey(x.key_b) }));
    return { data: { suggestions: s, note: "Display-only. Never merge without the user's explicit yes." }, text: s.map((x) => `${x.label_a} ≈ ${x.label_b} (${Math.round(x.similarity * 100)}%)`).join("\n") || "No suggestions." };
  }
  if (sub === "merge") {
    const a = requireFlag(flags, "alias", "model key, from `pcp groups --json`");
    const into = requireFlag(flags, "into");
    assertMergeAllowed(st.aliases, a, into);
    const today = ctx.today();
    const before = buildGroups(eligibleRows(st, ctx), ctx.config, today).filter((g) => [a, into].includes(g.resolved_key));
    const st2 = { ...st, aliases: new Map(st.aliases).set(a, into) };
    st2.resolve = (k) => resolveKey(st2.aliases, k);
    const after = buildGroups(eligibleRows(st2, ctx), ctx.config, today).filter((g) => g.resolved_key === into);
    const sum = (gs) => gs.map((g) => ({ group_id: g.id, tier: g.tier.tier, n: g.tier.n, sellers: g.tier.sellers, median: g.tier.median_minor === null ? "no data" : money(ctx, g.tier.median_minor) }));
    const preview = { before: sum(before), after: sum(after) };
    if (!flags.confirm) return { data: { needs_confirm: true, preview, hint: "Show this to the user. Re-run with --confirm only after they say yes." }, text: `Preview only (nothing changed):\nbefore: ${JSON.stringify(preview.before)}\nafter:  ${JSON.stringify(preview.after)}\nRe-run with --confirm after the user agrees.` };
    mergeAlias(ctx, a, into, st);
    return { data: { merged: a, into, preview }, text: `● Merged ${a} -> ${into} (reversible: pcp alias unmerge --alias ${a}).` };
  }
  if (sub === "unmerge") {
    unmergeAlias(ctx, requireFlag(flags, "alias"), st);
    return { data: { unmerged: flags.alias }, text: `● Unmerged ${flags.alias}.` };
  }
  throw new PcpError("USAGE", "Usage: pcp alias list | suggest | merge --alias K --into K [--confirm] | unmerge --alias K");
};

C.build = ({ pos, flags }) => {
  const sub = pos[1] || "list";
  if (sub === "list") {
    const p = presets();
    return { data: p, text: p.presets.map((x) => `${x.name} — ${x.title}: ${x.blurb}\n  ${x.parts.map((q) => `${q.component}: ${q.label}`).join("\n  ")}`).join("\n\n") + `\n\n${p.note}` };
  }
  if (sub === "template") {
    const preset = getPreset(pos[2] || "heavy");
    return { data: { name: preset.name, condition: "<ask the user: new|used|refurbished>", parts: preset.parts }, text: JSON.stringify({ name: preset.name, condition: "used", parts: preset.parts }, null, 2) };
  }
  if (sub === "total") {
    const ctx = ctxOf(flags);
    const condition = String(requireFlag(flags, "condition", "Ask the user which condition the build parts should be.")).toLowerCase();
    if (!CONDITIONS.includes(condition)) throw new PcpError("VALIDATION", `condition must be one of ${CONDITIONS.join(", ")}.`);
    let spec;
    if (flags.file) spec = JSON.parse(fs.readFileSync(String(flags.file), "utf8"));
    else {
      const preset = getPreset(requireFlag(flags, "preset", "e.g. --preset heavy"));
      spec = { name: preset.name, parts: preset.parts.map((p) => ({ ...p })) };
    }
    for (const s of flags.set || []) {
      const eq = String(s).indexOf("=");
      if (eq < 1) throw new PcpError("USAGE", `--set expects COMPONENT="model text" (got ${s}).`);
      const comp = s.slice(0, eq).toUpperCase();
      const match = s.slice(eq + 1);
      const part = spec.parts.find((p) => p.component.toUpperCase() === comp);
      if (part) part.match = match;
      else spec.parts.push({ component: comp, label: match, match });
    }
    spec.condition = condition;
    const r = buildTotals(ctx, ctx.store.state(), spec);
    const line = (t) => `${t.label}: ${t.all_good ? money(ctx, t.subtotal_minor) : `${money(ctx, t.subtotal_minor)} (${t.priced}/${t.parts} priced)`}`;
    const lines = r.parts.map((p) => `${p.component} — ${p.matched ?? "no logged match for " + JSON.stringify(p.match)}: asking ${p.asking && p.asking.tier.tier !== "none" ? `${p.asking.tier.tier === "good" ? money(ctx, p.asking.tier.median_minor) : "no good-tier median"} (${p.asking.tier.tier}${p.asking.level ? ", " + p.asking.level : ""})` : "no data"} · sold ${p.sold && p.sold.tier.tier !== "none" ? `${p.sold.tier.tier === "good" ? money(ctx, p.sold.tier.median_minor) : "no good-tier median"} (${p.sold.tier.tier}${p.sold.level ? ", " + p.sold.level : ""})` : "no data"}`);
    const checks = loadAsset("data/checklists.json");
    return { data: { ...r, user_checklist_header: checks.compat_header, user_checklist: checks.compat_user_checklist }, text: [...lines, "", line(r.asking_total), line(r.sold_total), "", checks.compat_header, ...checks.compat_user_checklist.map((c) => `[ ] ${c}`)].join("\n") };
  }
  throw new PcpError("USAGE", "Usage: pcp build list | template <name> | total --preset <name>|--file f --condition C [--set GPU=\"rx 6600\"]");
};

C.checklist = ({ pos, flags }) => {
  const checks = loadAsset("data/checklists.json");
  if (flags.compat) return { data: { header: checks.compat_header, items: checks.compat_user_checklist }, text: [checks.compat_header, ...checks.compat_user_checklist.map((c) => `[ ] ${c}`)].join("\n") };
  const comp = String(pos[1] || "").toUpperCase();
  if (!COMPONENTS.includes(comp)) throw new PcpError("USAGE", `Usage: pcp checklist <${COMPONENTS.join("|")}> | --compat`);
  const items = checklistFor(comp);
  return { data: { component: comp, items, test_before_pay: checks.test_before_pay, disclaimer: checks.disclaimer }, text: [...items.map((c) => `- ${c}`), checks.test_before_pay, checks.disclaimer].join("\n") };
};

C.key = ({ pos, flags }) => {
  const names = pos.slice(1);
  if (!names.length) throw new PcpError("USAGE", "Usage: pcp key --component GPU \"RX6600 8GB\" [\"Sapphire Pulse RX 6600\"]");
  const comp = String(requireFlag(flags, "component")).toUpperCase();
  let config = {};
  try { config = ctxOf(flags).config; } catch { /* identity works without a market */ }
  const keys = names.map((n) => ({ name: n, key: buildKey(comp, n, null, config) }));
  const same = keys.length > 1 ? keys.every((k) => k.key === keys[0].key) : null;
  return { data: { keys, same }, text: keys.map((k) => `${k.name} -> ${k.key}`).join("\n") + (same === null ? "" : `\n${same ? "SAME group" : "DIFFERENT groups (when unsure, the tool splits; merge only with the user's yes)"}`) };
};

C.export = ({ flags }) => {
  const ctx = ctxOf(flags);
  const st = ctx.store.state();
  const payload = flags["as-app"] ? pcpToApp(st, ctx) : exportData(ctx, st);
  if (flags.out) {
    fs.writeFileSync(String(flags.out), JSON.stringify(payload, null, 2) + "\n");
    return { data: { out: flags.out, observations: payload.observations.length }, text: `Wrote ${payload.observations.length} observations to ${flags.out}.` };
  }
  return { data: { export: payload }, raw: JSON.stringify(payload, null, 2) };
};

C.import = ({ pos, flags }) => {
  const ctx = ctxOf(flags);
  const file = pos[1];
  if (!file) throw new PcpError("USAGE", "Usage: pcp import <file.json> [--from-app] [--confirm] [--settings]");
  let payload = JSON.parse(fs.readFileSync(file, "utf8"));
  if (flags["from-app"]) payload = appToPcp(payload, ctx);
  const st = ctx.store.state();
  const dry = analyzeImport(ctx, st, payload);
  if (!dry.ok) return { data: dry, text: `Import refused: ${dry.error}` };
  if (!flags.confirm) return { data: { ...dry, dry_run: true }, text: `DRY RUN — add ${dry.counts.add}, identical ${dry.counts.identical}, conflict (local kept) ${dry.counts.conflict}, invalid (skipped) ${dry.counts.invalid}. Nothing written. Re-run with --confirm.` };
  const res = applyImport(ctx, st, payload, { applySettings: Boolean(flags.settings) });
  return { data: res, text: `● Imported ${res.applied.observations} new observation(s), ${res.applied.aliases_added} alias(es). Conflicts kept local: ${res.counts.conflict}.` };
};

C.backup = ({ flags }) => {
  const ctx = ctxOf(flags);
  if (!ctx.store.exists()) return { data: { skipped: true }, text: "Nothing to back up yet." };
  const dir = path.join(countryDir(ctx.cc), "backups");
  ensureDir(dir);
  const today = ctx.today().replace(/-/g, "");
  const existing = fs.readdirSync(dir).filter((f) => /^events-\d{8}-\d{6}\.jsonl$/.test(f)).sort();
  if (!flags.force && existing.some((f) => f.startsWith(`events-${today}`))) return { data: { skipped: true, reason: "A backup already exists for today (local date). Use --force." }, text: "Backup already exists for today; skipped." };
  const stamp = isoUtc().replace(/[-:]/g, "").replace("T", "-").replace("Z", "");
  const target = path.join(dir, `events-${stamp}.jsonl`);
  const tmp = `${target}.tmp`;
  fs.copyFileSync(ctx.store.file, tmp);
  // verify the copy is a readable log (a torn tail is tolerated exactly as on normal reads)
  const check = ctx.store.readEvents();
  const fd = fs.openSync(tmp, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, target);
  const all = fs.readdirSync(dir).filter((f) => /^events-\d{8}-\d{6}\.jsonl$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 7))) fs.rmSync(path.join(dir, old));
  return { data: { backup: target, events: check.events.length, kept: Math.min(all.length, 7) }, text: `● Backup written: ${target} (${check.events.length} events; keeping the latest 7).` };
};

const HELP = `pcp ${VERSION} — country-agnostic PC price intelligence (no network, no dependencies)

Setup     pcp init --country <ISO> [--currency X --tz Area/City --market "name"]
          pcp country list|show [CC]     pcp status     pcp doctor
          pcp profile show|import <file>     pcp config show|set|sanity|reset
Record    pcp log --component GPU --name "..." --price N --type asking|sold --condition used|new|refurbished|unknown --level local_market|online_domestic|other_domestic [--seller --date --notes ...]
          pcp correct <id> --price N ...   pcp void <id> --reason "..."   pcp unvoid|unmark-dup|override|chain <id>
Read      pcp latest "<model>" [--component --condition --type --level]    pcp trend "<model>"
          pcp groups [--component --level]    pcp list [filters]    pcp deal --component --name --price --condition [--level --text "listing"]
Builds    pcp build list|template <name>|total --preset heavy --condition used [--set GPU="rx 6600"]
Collect   pcp extract --text "..."|--file f|--stdin [--queue]    pcp candidates list|add|confirm <id>|discard <id>
Data      pcp export [--out f] [--as-app]    pcp import <f> [--from-app] [--confirm] [--settings]    pcp backup
Identity  pcp key --component GPU "name a" "name b"    pcp alias list|suggest|merge|unmerge
Other     pcp checklist <COMPONENT>|--compat

Always add --json when a program is reading the output. Global: --country CC (overrides the active country).
`;

// ---------------------------------------------------------------- main
export async function main(argv) {
  let json = false;
  try {
    const { pos, flags } = parseArgv(argv);
    json = Boolean(flags.json);
    const name = flags.help || !pos[0] ? "help" : pos[0];
    const fn = C[name];
    if (!fn) throw new PcpError("USAGE", `Unknown command "${name}".`, "Run `pcp help`.");
    const res = await fn({ pos, flags });
    if (res.raw !== undefined && !json) process.stdout.write(res.raw + "\n");
    else if (json) {
      if (ACTIVE_PROFILE) addMoneyText(res.data, ACTIVE_PROFILE);
      process.stdout.write(JSON.stringify({ ok: true, ...res.data }, null, 2) + "\n");
    }
    else process.stdout.write((res.text ?? JSON.stringify(res.data, null, 2)) + "\n");
    return 0;
  } catch (e) {
    const err = e instanceof PcpError ? e : new PcpError("INTERNAL", e?.message || String(e));
    if (json || !process.stderr.isTTY) {
      process.stdout.write(JSON.stringify({ ok: false, error: { code: err.code, message: err.message, hint: err.hint, details: err.details } }, null, 2) + "\n");
    } else {
      process.stderr.write(`error [${err.code}]: ${err.message}\n${err.hint ? `hint: ${err.hint}\n` : ""}`);
    }
    return err.code === "USAGE" ? 2 : 1;
  }
}

// Entry-point check by REAL path: launching through a symlink (link installs, PATH shims) must still run.
function isEntryPoint() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
