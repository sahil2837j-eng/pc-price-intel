#!/usr/bin/env node
// Optional, explicit market collector for pc-price-intel.
//
// The core `pcp` CLI has no network code. This separate script runs only when a human or
// agent invokes it, fetches ONE public search page per run, and queues what it found as
// candidates. It never confirms candidates and never writes statistics.
//
// It deliberately does not bypass CAPTCHAs, log in, or crawl. Sources whose robots.txt
// disallows the search path (Daraz /catalog/, Alibaba /trade/) are manual-only here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PCP = path.join(HERE, "..", "scripts", "pcp.mjs");
const USER_AGENT = "pc-price-intel-collector/1.1 (local, user-initiated; public page only)";
const CONDITIONS = ["new", "used", "refurbished", "unknown"];
const PRICE_TYPES = ["asking", "sold"];
const LEVELS = ["local_market", "online_domestic", "other_domestic", "unknown"];

const SOURCES = {
  olx: {
    label: "OLX Pakistan",
    network: true,
    manual: true,
    reference: false,
    level: "online_domestic",
    searchUrl: (q) => `https://www.olx.com.pk/items/q-${encodeURIComponent(q).trim().replace(/%20/g, "-")}`,
    allowedUrl: (u) => u.hostname === "www.olx.com.pk" && u.pathname.startsWith("/items/"),
    parse: parseOlxListings,
    note: "Public search page. Seller names are not shown on the search page; open the listing URL and pass --seller when confirming.",
  },
  amazon: {
    label: "Amazon.com",
    network: true,
    manual: true,
    reference: true,
    level: "unknown",
    searchUrl: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
    allowedUrl: (u) => u.hostname.endsWith("amazon.com") && u.pathname === "/s",
    parse: parseAmazonListings,
    note: "Public search page. Retail/import reference only; it is not the local used market and never enters statistics by default.",
  },
  daraz: {
    label: "Daraz Pakistan",
    network: false,
    manual: true,
    reference: false,
    level: "online_domestic",
    parse: parseDarazJson,
    note: "Manual import only: robots.txt disallows /catalog/. Save the search JSON/page yourself and pass --file or --stdin.",
  },
  alibaba: {
    label: "Alibaba",
    network: true,
    manual: true,
    reference: true,
    level: "unknown",
    searchUrl: null,
    allowedUrl: (u) => u.hostname.endsWith("alibaba.com") && u.pathname.startsWith("/product-detail/"),
    parse: parseAlibabaProduct,
    note: "Public product-detail pages only. Search /trade/ is disallowed by robots.txt and returns CAPTCHA/punish pages. Wholesale/MOQ data is reference-only, never a local retail or used-market price.",
  },
};

const USAGE = `pc-price-intel optional collector (one public page per run; candidates only)

Usage:
  node tools/collect.mjs olx --query "rx 6600" --component GPU --require "rx\\s*6600" --exclude "xt|bundle|full pc" [--queue] [--json]
  node tools/collect.mjs amazon --query "rx 6600" --component GPU --require "rx\\s*6600" --exclude "xt" [--queue] [--json]
  node tools/collect.mjs daraz --file daraz.json --component GPU --require "rx\\s*6600" [--queue] [--json]
  node tools/collect.mjs olx --url "https://www.olx.com.pk/items/q-rx-6600" --component GPU [--queue]

Sources:
  olx      public OLX Pakistan search page (network allowed)
  amazon   public Amazon.com search page (network allowed; reference-only by default)
  daraz    manual only (robots.txt disallows /catalog/)
  alibaba  product-detail page only (search is CAPTCHA-protected; /trade/ disallowed; reference-only)

Options:
  --source NAME          alternative to positional source
  --query TEXT           build one search URL from the source
  --url URL              fetch this one public page instead
  --file PATH            parse a saved page/JSON (no network)
  --stdin                read a saved page/JSON from stdin (no network)
  --component COMPONENT  GPU, CPU, RAM, MOTHERBOARD, PSU, SSD, HDD, CASE, COOLER, OTHER
  --condition C          new | used | refurbished | unknown (otherwise inferred, else unknown)
  --type T               asking | sold (default asking)
  --level L              local_market | online_domestic | other_domestic | unknown
  --require REGEX        keep only titles matching this case-insensitive regex
  --exclude REGEX        drop titles matching this case-insensitive regex
  --min-price N          keep prices at or above N in major units
  --max-price N          keep prices at or below N in major units
  --max N                maximum rows (default 20, cap 50)
  --reference            mark rows as reference-only (excluded from statistics)
  --no-reference         override the source default
  --queue                queue rows with pcp candidates add; a human still confirms
  --country CC           pass a country to pcp (otherwise active country)
  --json                 machine-readable output
  --help
`;

function fail(message, code = "COLLECT") {
  const e = new Error(message);
  e.code = code;
  throw e;
}

function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(s ?? "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    const key = e.toLowerCase();
    if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
    if (key.startsWith("#")) return String.fromCodePoint(parseInt(key.slice(1), 10));
    return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : m;
  });
}

function cleanText(s) {
  return decodeEntities(String(s ?? "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function matchText(text, re) {
  const m = String(text ?? "").match(re);
  return m ? cleanText(m[1]) : null;
}

function hrefOf(text, re) {
  const m = String(text ?? "").match(re);
  if (!m) return null;
  return decodeEntities(m[1]).trim();
}

function absoluteUrl(href, base) {
  if (!href) return null;
  try {
    if (href.startsWith("//")) return `https:${href}`;
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function currencyDecimals(code) {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

/** Parse a displayed price into { amount, currency } without converting currencies. */
export function parseMoney(raw) {
  const text = decodeEntities(String(raw ?? "")).replace(/\u00a0/g, " ").trim();
  if (!text) return null;
  let currency = null;
  if (/\bPKR\b|(?:^|\s)Rs\.?(?=\s|\d)|₨/i.test(text)) currency = "PKR";
  else if (/\bUSD\b|US\s*\$|\$/.test(text)) currency = "USD";
  else if (/\bEUR\b|€/.test(text)) currency = "EUR";
  else if (/\bGBP\b|£/.test(text)) currency = "GBP";
  else if (/\bAED\b|د\.إ/.test(text)) currency = "AED";
  const m = text.match(/(\d[\d,.]*)\s*(lac|lakh|crore|cr|k)?/i);
  if (!m) return null;
  let amount = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;
  const suffix = (m[2] || "").toLowerCase();
  if (suffix === "lac" || suffix === "lakh") amount *= 100000;
  else if (suffix === "crore" || suffix === "cr") amount *= 10000000;
  else if (suffix === "k") amount *= 1000;
  return { amount, currency: currency || "PKR" };
}

function normalizeAmount(amount, currency) {
  const d = currencyDecimals(currency);
  return Math.round(amount * 10 ** d) / 10 ** d;
}

export function inferCondition(title) {
  const t = String(title ?? "").toLowerCase();
  if (/\b(refurbished|refurb)\b/.test(t)) return "refurbished";
  if (/\b(used|second[- ]?hand|secondhand|pre[- ]?owned|open box|pulled|like new|lightly used)\b/.test(t)) return "used";
  if (/\b(brand new|sealed|unopened|new)\b/.test(t)) return "new";
  return null;
}

function listing({ name, priceText, url, seller = null, location = null, dateText = null, condition, type, level, reference, component, source, listingId = null, extra = null }) {
  const money = parseMoney(priceText);
  if (!name || !money) return null;
  const price = normalizeAmount(money.amount, money.currency);
  const quote = [name, priceText, seller, location, dateText].filter(Boolean).join(" · ");
  return {
    name: cleanText(name),
    price,
    currency: money.currency,
    price_display: cleanText(priceText),
    component: component || null,
    type: type || "asking",
    condition: condition || inferCondition(name) || "unknown",
    seller: seller ? cleanText(seller) : null,
    location: location ? cleanText(location) : null,
    quote,
    url,
    listing_id: listingId,
    level,
    evidence: reference ? "reference" : "reported",
    source,
    ...(extra || {}),
  };
}

export function parseOlxListings(html, opts = {}) {
  const blocks = [...String(html ?? "").matchAll(/<li[^>]*\baria-label="Listing"[^>]*>[\s\S]*?<\/li>/gi)].map((m) => m[0]);
  const out = [];
  for (const block of blocks) {
    const name = matchText(block, /\btitle="([^"]+)"/i) || matchText(block, /<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const href = hrefOf(block, /<a[^>]*href="([^"]*\/item\/[^"]+)"/i);
    const priceText = matchText(block, /<div[^>]*aria-label="Price"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
    const location = matchText(block, /<span[^>]*aria-label="Location"[^>]*>([\s\S]*?)<span/i)?.replace(/[•·]/g, " ").trim() || null;
    const dateText = matchText(block, /<span[^>]*aria-label="Creation date"[^>]*>([\s\S]*?)<\/span>/i);
    const url = absoluteUrl(href, "https://www.olx.com.pk");
    const listingId = href ? (href.match(/-iid-(\d+)/i)?.[1] || null) : null;
    const row = listing({
      name,
      priceText,
      url,
      location,
      dateText,
      condition: opts.condition,
      type: opts.type,
      level: opts.level || "online_domestic",
      reference: Boolean(opts.reference),
      component: opts.component,
      source: "olx",
      listingId,
    });
    if (row) out.push(row);
  }
  return out;
}

export function parseAmazonListings(html, opts = {}) {
  const text = String(html ?? "");
  const starts = [...text.matchAll(/<div[^>]*data-component-type="s-search-result"[^>]*>/gi)].map((m) => m.index);
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const chunk = text.slice(starts[i], starts[i + 1] ?? Math.min(text.length, starts[i] + 50000));
    const asin = chunk.match(/data-asin="([A-Z0-9]{10})"/i)?.[1] || null;
    const name =
      matchText(chunk, /<h2[^>]*aria-label="([^"]+)"/i) ||
      matchText(chunk, /<h2[^>]*class="[^"]*a-text-normal[^"]*"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i) ||
      matchText(chunk, /<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/h2>/i);
    const priceText = matchText(chunk, /<span[^>]*class="a-offscreen"[^>]*>([\s\S]*?)<\/span>/i);
    const href = hrefOf(chunk, /href="([^"]*\/dp\/[A-Z0-9]{10}[^"]*)"/i);
    const url = absoluteUrl(href, "https://www.amazon.com");
    const row = listing({
      name,
      priceText,
      url,
      dateText: "Amazon.com search result",
      condition: opts.condition,
      type: opts.type,
      level: opts.level || "unknown",
      reference: opts.reference ?? true,
      component: opts.component,
      source: "amazon",
      listingId: asin,
      extra: { asin },
    });
    if (row) out.push(row);
  }
  return out;
}

export function parseDarazJson(raw, opts = {}) {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  const items = data?.mods?.listItems || data?.listItems || [];
  const out = [];
  for (const item of items) {
    const name = cleanText(item.name || item.title);
    const priceText = cleanText(item.priceShow || item.price);
    const url = absoluteUrl(item.itemUrl || item.link || null, "https://www.daraz.pk");
    const row = listing({
      name,
      priceText,
      url,
      seller: item.sellerName || null,
      location: item.location || null,
      condition: opts.condition,
      type: opts.type,
      level: opts.level || "online_domestic",
      reference: Boolean(opts.reference),
      component: opts.component,
      source: "daraz",
      listingId: item.itemId || item.nid || null,
    });
    if (row) out.push(row);
  }
  return out;
}

function visibleText(html) {
  return cleanText(
    String(html ?? "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " "),
  );
}

/** Alibaba product-detail parser. Search is blocked; a single product page is explicit. */
export function parseAlibabaProduct(html, opts = {}) {
  const blocks = [...String(html ?? "").matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  let product = null;
  for (const block of blocks) {
    let data;
    try {
      data = JSON.parse(block[1]);
    } catch {
      continue;
    }
    const items = Array.isArray(data) ? data : [data];
    product = items.find((x) => x && (x["@type"] === "Product" || (Array.isArray(x["@type"]) && x["@type"].includes("Product")))) || product;
  }
  if (!product) return [];
  const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
  if (!offers || offers.price === undefined) return [];
  const rawName = cleanText(product.name).replace(/\s*-\s*Buy\s+Product on Alibaba\.com\s*$/i, "").trim();
  const priceText = `${offers.priceCurrency || "USD"} ${offers.price}`;
  const visible = visibleText(html);
  const moqText = visible.match(/Minimum order quantity:\s*([\d,]+)\s*pieces?/i)?.[0] || null;
  const aroundMoq = moqText ? visible.slice(Math.max(0, visible.indexOf(moqText) - 400), visible.indexOf(moqText) + moqText.length + 100) : visible.slice(0, 2000);
  const range = aroundMoq.match(/(?:PKR|US\s*\$|USD)\s*[\d,.]+\s*-\s*(?:PKR|US\s*\$|USD)?\s*[\d,.]+/i)?.[0] || null;
  const seller = product.brand?.name ? cleanText(product.brand.name) : null;
  const url = opts.url || absoluteUrl(offers.url, "https://www.alibaba.com");
  const quote = [
    rawName,
    priceText,
    range ? `page range ${range}` : null,
    moqText ? moqText.replace(/^Minimum order quantity:\s*/i, "MOQ ") : null,
    seller ? `supplier ${seller}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const row = listing({
    name: rawName,
    priceText,
    url,
    seller,
    dateText: "Alibaba product-detail reference",
    condition: opts.condition,
    type: opts.type,
    level: opts.level || "unknown",
    reference: opts.reference ?? true,
    component: opts.component,
    source: "alibaba",
    listingId: product.sku || product["@id"] || null,
    extra: { moq: moqText || null, price_range_display: range, supplier: seller, quote },
  });
  if (row) row.quote = quote;
  return row ? [row] : [];
}

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  const bool = new Set(["queue", "json", "stdin", "help", "reference", "no-reference"]);
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
      else if (bool.has(key)) val = true;
      else {
        val = argv[++i];
        if (val === undefined) fail(`--${key} needs a value.`, "USAGE");
      }
      flags[key] = val;
    } else pos.push(a);
  }
  return { pos, flags };
}

function compile(pattern, label) {
  if (!pattern) return null;
  try {
    return new RegExp(String(pattern), "i");
  } catch (e) {
    fail(`Invalid ${label} regex: ${e.message}`, "USAGE");
  }
}

function numberFlag(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) fail(`--${label} must be a non-negative number.`, "USAGE");
  return n;
}

function applyFilters(rows, opts) {
  return rows
    .filter((r) => !opts.requireRe || opts.requireRe.test(r.name))
    .filter((r) => !opts.excludeRe || !opts.excludeRe.test(r.name))
    .filter((r) => opts.minPrice === null || r.price >= opts.minPrice)
    .filter((r) => opts.maxPrice === null || r.price <= opts.maxPrice)
    .filter((r) => r.price > 0)
    .sort((a, b) => a.price - b.price)
    .slice(0, opts.max);
}

async function fetchPage(url) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30000),
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
  });
  const text = await res.text();
  if (!res.ok) fail(`HTTP ${res.status} from ${res.url}.`, "HTTP");
  const head = text.slice(0, 40000);
  if (/<title>\s*(Robot Check|Sorry, we just need to make sure)/i.test(head) || /id="captchacharacters"/i.test(head) || /\bpunish\b/i.test(head)) {
    fail("The source returned a CAPTCHA/robot page. Not bypassing it; use --file with a page you saved manually.", "BLOCKED");
  }
  return { text, finalUrl: res.url };
}

function queueRows(rows, { source, country }) {
  const tmp = path.join(os.tmpdir(), `pcp-collect-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(rows));
  try {
    const args = [PCP, "candidates", "add", "--file", tmp, "--source", source, "--json"];
    if (country) args.push("--country", String(country));
    const r = spawnSync(process.execPath, args, { encoding: "utf8", env: process.env });
    let parsed = null;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      /* fall through to the error below */
    }
    if (r.status !== 0 || !parsed?.ok) {
      fail(parsed?.error?.message || r.stderr || r.stdout || `pcp candidates add failed (exit ${r.status}).`, "QUEUE");
    }
    return parsed.queued_ids || [];
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function moneyText(row) {
  try {
    return `${row.currency} ${new Intl.NumberFormat("en", { maximumFractionDigits: currencyDecimals(row.currency) }).format(row.price)}`;
  } catch {
    return `${row.currency} ${row.price}`;
  }
}

function trunc(s, n) {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function printTable(rows) {
  if (!rows.length) return "No listings matched the filters. Nothing queued.";
  const lines = [];
  lines.push("  #  Title                                                       Price            Cond        Seller             Location");
  rows.forEach((r, i) => {
    lines.push(
      `${String(i + 1).padStart(3)}  ${trunc(r.name, 58).padEnd(58)}  ${moneyText(r).padStart(15)}  ${String(r.condition || "—").padEnd(10)}  ${trunc(r.seller || "—", 17).padEnd(17)}  ${trunc(r.location || "—", 20)}`,
    );
    if (r.url) lines.push(`     ${r.url}`);
  });
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  let json = false;
  try {
    const { pos, flags } = parseArgs(argv);
    json = Boolean(flags.json);
    if (flags.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    const sourceName = String(flags.source || pos[0] || "").toLowerCase();
    const def = SOURCES[sourceName];
    if (!def) fail(`Unknown source "${sourceName}". Use one of: ${Object.keys(SOURCES).join(", ")}.`, "USAGE");

    if (flags.reference && flags["no-reference"]) fail("Use only one of --reference and --no-reference.", "USAGE");
    const reference = flags.reference ? true : flags["no-reference"] ? false : def.reference;
    const type = String(flags.type || "asking").toLowerCase();
    if (!PRICE_TYPES.includes(type)) fail(`--type must be one of ${PRICE_TYPES.join(", ")}.`, "USAGE");
    const condition = flags.condition ? String(flags.condition).toLowerCase() : null;
    if (condition && !CONDITIONS.includes(condition)) fail(`--condition must be one of ${CONDITIONS.join(", ")}.`, "USAGE");
    const level = flags.level ? String(flags.level).toLowerCase() : def.level;
    if (!LEVELS.includes(level)) fail(`--level must be one of ${LEVELS.join(", ")}.`, "USAGE");
    const max = Math.min(Number(flags.max) || 20, 50);
    if (max < 1) fail("--max must be at least 1.", "USAGE");

    const parseOpts = {
      component: flags.component ? String(flags.component).toUpperCase() : null,
      type,
      condition,
      level,
      reference,
    };
    const filters = {
      requireRe: compile(flags.require, "require"),
      excludeRe: compile(flags.exclude, "exclude"),
      minPrice: numberFlag(flags["min-price"], "min-price"),
      maxPrice: numberFlag(flags["max-price"], "max-price"),
      max,
    };

    let text;
    let pageUrl = null;
    let fetchedAt = null;
    if (flags.file || flags.stdin) {
      text = flags.file ? fs.readFileSync(String(flags.file), "utf8") : fs.readFileSync(0, "utf8");
      pageUrl = flags.url ? String(flags.url) : null;
      if (!def.manual) fail(def.note, "MANUAL_ONLY");
    } else {
      if (!def.network) fail(def.note, "MANUAL_ONLY");
      const query = String(flags.query || "").trim();
      if (!flags.url && !query) fail("Provide --query, --url, --file or --stdin.", "USAGE");
      const requested = flags.url ? String(flags.url) : def.searchUrl ? def.searchUrl(query) : null;
      if (!requested) fail(def.note, "MANUAL_ONLY");
      let parsedUrl;
      try {
        parsedUrl = new URL(requested);
      } catch {
        fail(`Not a valid URL: ${requested}`, "USAGE");
      }
      if (!def.allowedUrl(parsedUrl)) fail(`This collector only fetches the documented public search path for ${def.label}. Refusing ${requested}`, "SOURCE_RULE");
      const fetched = await fetchPage(parsedUrl.href);
      text = fetched.text;
      pageUrl = fetched.finalUrl;
      fetchedAt = new Date().toISOString();
    }

    const rawRows = def.parse(text, parseOpts);
    const rows = applyFilters(rawRows, filters);
    const queued = flags.queue ? queueRows(rows, { source: sourceName, country: flags.country }) : [];

    const payload = {
      ok: true,
      source: sourceName,
      label: def.label,
      url: pageUrl,
      fetched_at: fetchedAt,
      reference,
      count: rows.length,
      listings: rows,
      queued_ids: queued,
      note: flags.queue
        ? "Queued as candidates. Nothing is in statistics until a human confirms component, type and condition."
        : "Nothing queued. Re-run with --queue after reviewing the rows.",
      source_note: def.note,
    };

    if (json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      const lines = [
        `${def.label} · ${rows.length} listing${rows.length === 1 ? "" : "s"} · ${reference ? "reference-only" : "domestic candidate"}`,
        pageUrl ? `page: ${pageUrl}` : "source: local file/stdin (no network)",
        "",
        printTable(rows),
        "",
        ...(queued.length ? [`Queued ${queued.length} candidate(s): ${queued.join(", ")}.`, "Nothing is in statistics until you confirm them with `pcp candidates confirm`."] : ["Nothing queued. Add --queue to send these rows to the review queue."]),
        reference ? "Reference rows are excluded from price statistics even after confirmation." : null,
        def.note,
      ].filter(Boolean);
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    return 0;
  } catch (e) {
    const message = e?.message || String(e);
    const code = e?.code || "COLLECT";
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } }, null, 2)}\n`);
    else process.stderr.write(`error [${code}]: ${message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(await main());
}
