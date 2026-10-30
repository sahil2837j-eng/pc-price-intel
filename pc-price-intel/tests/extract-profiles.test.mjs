import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cleanListingTitle, extractPrices, htmlToText } from "../scripts/lib/extract.mjs";
import { listCountries, loadProfile, validateProfileFile } from "../scripts/lib/profiles.mjs";
import { SKILL_DIR } from "./helpers.mjs";

const vals = (list, cur) => list.filter((f) => f.currency === cur).map((f) => f.value).sort((a, b) => a - b);

test("PK: prices appear verbatim; 'Processors 1792' is not a price", () => {
  const pk = loadProfile("PK");
  const text = "Radeon RX 6600 Stream Processors 1792 Boost. Used price in Pakistan is Rs.53,000. Old Rs 58,000. kit 3,200/- final. PKR 16500. ₨ 126,000";
  assert.deepEqual(vals(extractPrices(text, pk), "PKR"), [3200, 16500, 53000, 58000, 126000]);
  assert.deepEqual(extractPrices("no prices here, 1792 cores", pk), []);
});

test("quotes are verbatim snippets that contain the price", () => {
  const pk = loadProfile("PK");
  const [hit] = extractPrices("Asus Dual RX 6600 – Used. Price: Rs. 53,000 only", pk);
  assert.ok(hit.quote.includes("53,000"));
});

test("US: dollars with cents; foreign benchmarks are tagged with their own currency", () => {
  const us = loadProfile("US");
  const r = extractPrices("Brand new $1,299.99 shipped. EU listing €178 sold.", us);
  const usd = r.find((f) => f.currency === "USD");
  assert.equal(usd.value, 1299.99);
  assert.equal(usd.value_minor, 129999);
  assert.equal(r.find((f) => f.currency === "EUR").value, 178);
});

test("IN: lakh grouping and the rupee sign", () => {
  assert.deepEqual(vals(extractPrices("Laptop ₹ 1,25,000 and GPU Rs. 45,000", loadProfile("IN")), "INR"), [45000, 125000]);
});

test("generated profile (Kenya) still extracts by currency code", () => {
  const ke = loadProfile("KE");
  assert.equal(ke.source, "generated");
  assert.deepEqual(vals(extractPrices("RAM 16GB KES 4,500", ke), "KES"), [4500]);
});

test("a custom capture-group pattern is honoured", () => {
  const pk = loadProfile("PK");
  const r = extractPrices("Our rate: 47500 only", pk, { pattern: "rate:\\s*(\\d+)" });
  assert.deepEqual(vals(r, "PKR"), [47500]);
});

test("listing titles lose condition and marketing words but keep Ti/XT/capacity", () => {
  const pk = loadProfile("PK");
  assert.equal(cleanListingTitle("Asus Dual RX 6600 8GB - Used", pk), "Asus Dual RX 6600 8GB");
  assert.equal(cleanListingTitle("RTX 3060 Ti 8GB (Used) urgent", pk), "RTX 3060 Ti 8GB");
  assert.equal(cleanListingTitle("Sapphire Pulse RX 6600 8GB Graphics Card – Used ₨ 53,000", pk), "Sapphire Pulse RX 6600 8GB");
});

test("html is reduced to text", () => {
  assert.match(htmlToText("<p>Price: Rs&nbsp;5,000</p><script>x=1</script>"), /Price: Rs 5,000/);
});

test("profiles: bundled facts load; any country works; unknown ones ask for facts", () => {
  const pk = loadProfile("PK");
  assert.equal(pk.currency, "PKR");
  assert.equal(pk.decimals, 0);
  assert.equal(pk.timezone, "Asia/Karachi");
  assert.equal(loadProfile("KW").decimals, 3);
  assert.equal(loadProfile("JP").decimals, 0);
  assert.throws(() => loadProfile("ZZ"), (e) => e.code === "UNKNOWN_COUNTRY");
  const custom = loadProfile("ZZ", { currency: "usd", tz: "UTC" });
  assert.equal(custom.currency, "USD");
  assert.throws(() => loadProfile("XX", { currency: "NOPE", tz: "UTC" }), (e) => e.code === "BAD_CURRENCY");
  assert.throws(() => loadProfile("XX", { currency: "USD", tz: "Mars/Base" }), (e) => e.code === "BAD_TIMEZONE");
  assert.throws(() => loadProfile("PAK"), (e) => e.code === "BAD_COUNTRY");
});

test("every country in the table resolves to a valid currency and time zone", () => {
  for (const c of listCountries()) {
    const p = loadProfile(c.cc);
    assert.ok(Number.isInteger(p.decimals) && p.decimals >= 0 && p.decimals <= 3, c.cc);
    assert.ok(p.symbol, c.cc);
  }
});

test("every bundled profile file validates and matches its file name", () => {
  const dir = path.join(SKILL_DIR, "assets", "profiles");
  for (const f of fs.readdirSync(dir).filter((x) => /^[A-Z]{2}\.json$/.test(x))) {
    const obj = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    assert.equal(validateProfileFile(obj).country, f.slice(0, 2));
    assert.equal(obj.verified, false, `${f}: facts must be re-verified live by the agent`);
    assert.ok(obj.reviewed, `${f}: reviewed date`);
  }
});
