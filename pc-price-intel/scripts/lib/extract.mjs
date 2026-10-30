// Price extraction from pasted or fetched text. CODE ONLY: a price is accepted only when it
// appears verbatim in the text, and the surrounding snippet is kept as the quote. The tool
// itself never fetches anything; the agent fetches/pastes text and hands it here.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function numberPattern(nf, decimals) {
  const th = esc(nf.thousands);
  const dec = esc(nf.decimal);
  const group = nf.grouping === "flexible" ? "\\d{2,3}" : "\\d{3}";
  const frac = decimals > 0 ? `(?:${dec}\\d{1,${decimals}})?` : "";
  return `(\\d{1,3}(?:${th}${group})+${frac}|\\d{1,9}${frac})`;
}

function alt(markers) {
  return [...new Set(markers)].sort((a, b) => b.length - a.length).map(esc).join("|");
}

function parseCaptured(str, nf) {
  let s = str.split(nf.thousands).join("");
  if (nf.decimal !== ".") s = s.split(nf.decimal).join(".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function snippet(text, index, length) {
  return text.slice(Math.max(0, index - 60), Math.min(text.length, index + length + 60)).replace(/\s+/g, " ").trim();
}

const FOREIGN = [
  { currency: "USD", markers: ["US$", "USD"], bareSymbol: "$" },
  { currency: "EUR", markers: ["EUR", "€"] },
  { currency: "GBP", markers: ["GBP", "£"] },
];

/**
 * @param {string} text
 * @param {object} profile  effective profile (currency, decimals, number_format, price_markers, extract_bounds)
 * @param {{pattern?:string|null, max?:number}} [opts]
 * @returns {{value:number, value_minor:number, currency:string, quote:string}[]}
 */
export function extractPrices(text, profile, opts = {}) {
  const max = opts.max ?? 20;
  const out = [];
  const seen = new Set();
  const nf = profile.number_format;
  const bounds = profile.extract_bounds || { min: 1, max: 1e9 };
  const push = (major, currency, decimals, quote) => {
    const key = `${currency}:${major}`;
    if (seen.has(key) || out.length >= max) return;
    seen.add(key);
    out.push({ value: major, value_minor: Math.round(major * 10 ** decimals), currency, quote });
  };

  // 1. Optional user/agent pattern with ONE capture group for the number.
  if (opts.pattern) {
    try {
      const re = new RegExp(opts.pattern, "gi");
      let m;
      while ((m = re.exec(text)) && out.length < max) {
        const major = parseCaptured((m[1] ?? m[0]).replace(/[^\d.,]/g, ""), nf);
        if (major !== null && major >= bounds.min && major <= bounds.max) push(major, profile.currency, profile.decimals, snippet(text, m.index, m[0].length));
        if (m[0].length === 0) re.lastIndex++;
      }
    } catch {
      /* invalid pattern: fall through to the profile's own markers */
    }
  }

  // 2. The profile's own markers, e.g. "Rs. 53,000", "₹ 45,000", "3,200/-", "PKR 16500".
  const num = numberPattern(nf, profile.decimals);
  const pm = profile.price_markers || { prefix: [], suffix: [] };
  const patterns = [];
  if (pm.prefix?.length) patterns.push(new RegExp(`(?<![A-Za-z])(?:${alt(pm.prefix)})\\s*:?\\s*${num}(?!\\d)`, "gi"));
  if (pm.suffix?.length) patterns.push(new RegExp(`(?<![\\d,.])${num}\\s*(?:${alt(pm.suffix)})(?![A-Za-z])`, "gi"));
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) && out.length < max) {
      const major = parseCaptured(m[1], nf);
      if (major !== null && major >= bounds.min && major <= bounds.max) push(major, profile.currency, profile.decimals, snippet(text, m.index, m[0].length));
    }
  }

  // 3. Foreign-currency benchmarks (kept as reference rows; never statistics).
  const stdNum = numberPattern({ thousands: ",", decimal: ".", grouping: "standard" }, 2);
  for (const f of FOREIGN) {
    if (f.currency === profile.currency) continue;
    const markers = [...f.markers];
    if (f.bareSymbol && profile.symbol !== f.bareSymbol) markers.push(f.bareSymbol);
    const re = new RegExp(`(?<![A-Za-z])(?:${alt(markers)})\\s*${stdNum}(?!\\d)`, "g");
    let m;
    while ((m = re.exec(text)) && out.length < max) {
      const major = parseCaptured(m[1], { thousands: ",", decimal: "." });
      if (major !== null && major >= 10 && major <= 50000) push(major, f.currency, currencyDecimalsSafe(f.currency), snippet(text, m.index, m[0].length));
    }
  }
  return out;
}

function currencyDecimalsSafe(code) {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

// Listing-title cleanup, applied ONLY to collected rows, never to what the user types:
// "Asus Dual RX 6600 8GB - Used" -> "Asus Dual RX 6600 8GB".
const TITLE_NOISE = [
  /\b(brand\s+new|like\s+new|new|used|refurbished|refurb|pulled\s*out|open\s*box|sealed|boxed|tested|untested)\b/gi,
  /\b(graphics?\s+cards?|video\s+cards?|desktop\s+processors?|processors?|motherboards?|memory\s+modules?|for\s+sale|urgent|cheap|original|genuine|gaming\s+pc)\b/gi,
];

export function cleanListingTitle(title, profile) {
  let t = String(title).normalize("NFKC");
  for (const re of TITLE_NOISE) t = t.replace(re, " ");
  // drop any price-looking fragment still in the title
  if (profile) {
    const pm = profile.price_markers || { prefix: [], suffix: [] };
    const all = [...(pm.prefix || []), ...(pm.suffix || [])].filter((m) => m !== "/-");
    if (all.length) t = t.replace(new RegExp(`(?:${alt(all)})\\s*[\\d.,]+`, "gi"), " ");
  }
  t = t.replace(/[–—|•·]+/g, " ").replace(/\(\s*\)/g, " ").replace(/\s+/g, " ").replace(/\s*[-:]\s*$/g, "").trim();
  return t.length >= 2 ? t : String(title).trim();
}

export function guessName(text) {
  const first = text.split("\n").map((l) => l.trim()).find((l) => l.length >= 4 && l.length <= 120 && !/^https?:\/\//i.test(l));
  return first || null;
}

/** Crude, dependency-free HTML to text, for agents that hand over raw HTML. */
export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch { return " "; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return " "; }
    })
    .replace(/&(trade|reg|copy|ndash|mdash|hellip|rsquo|lsquo|rdquo|ldquo);/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}
