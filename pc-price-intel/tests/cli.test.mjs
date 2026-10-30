import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { logRow, run, tmpDir } from "./helpers.mjs";

function market(country = "PK") {
  const dir = tmpDir();
  assert.equal(run(["init", "--country", country], { dir }).json.ok, true);
  return dir;
}
function threeGpu(dir, name = "RX 6600", base = 46000) {
  logRow(dir, { name, price: base - 1000, seller: "Shop A" });
  logRow(dir, { name, price: base, seller: "Shop B" });
  logRow(dir, { name, price: base + 1000, seller: "Shop C" });
}

test("no country set: structured error with a recovery hint (the agent must decide)", () => {
  const r = run(["status"], { dir: tmpDir() });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, "NO_COUNTRY");
  assert.match(r.json.error.hint, /pcp init --country/);
});

test("init works for a curated country, a table-only country, and a brand-new one", () => {
  const dir = tmpDir();
  const pk = run(["init", "--country", "PK", "--market", "Saddar, Peshawar"], { dir }).json;
  assert.equal(pk.currency, "PKR");
  assert.equal(pk.profile_source, "bundled");
  assert.ok(pk.online_sources.length > 0);
  assert.equal(run(["status"], { dir }).json.home_market, "Saddar, Peshawar");

  const ke = run(["init", "--country", "KE"], { dir }).json;
  assert.equal(ke.profile_source, "generated");
  assert.equal(ke.currency, "KES");

  assert.equal(run(["init", "--country", "ZZ"], { dir }).json.error.code, "UNKNOWN_COUNTRY");
  const zz = run(["init", "--country", "ZZ", "--currency", "EUR", "--tz", "Europe/Paris"], { dir }).json;
  assert.equal(zz.ok, true);
  assert.equal(zz.profile_source, "user");
  // the invented profile is remembered in the user's data dir, not in the skill folder
  assert.ok(fs.existsSync(path.join(dir, "profiles", "ZZ.json")));
});

test("log refuses a missing type/condition; latest reports tier and median with the tier word", () => {
  const dir = market();
  const bad = run(["log", "--component", "GPU", "--name", "RX6600", "--price", "46000"], { dir });
  assert.equal(bad.json.error.code, "VALIDATION");
  assert.match(bad.json.error.message, /type/);
  threeGpu(dir);
  const m = run(["latest", "RX 6600 8GB", "--condition", "used"], { dir }).json.matches;
  assert.equal(m.length, 1);
  assert.equal(m[0].tier, "good");
  assert.equal(m[0].median_minor, 46000);
  assert.equal(m[0].n, 3);
  assert.equal(m[0].sellers, 3);
  assert.equal(m[0].latest.price_minor, 47000);
});

test("latest never pulls the XT variant into the plain model (exact first)", () => {
  const dir = market();
  threeGpu(dir, "RX 6600", 46000);
  threeGpu(dir, "RX 6600 XT", 70000);
  const m = run(["latest", "rx 6600", "--condition", "used"], { dir }).json.matches;
  assert.equal(m.length, 1);
  assert.equal(m[0].median_minor, 46000);
  const xt = run(["latest", "rx 6600 xt", "--condition", "used"], { dir }).json.matches;
  assert.equal(xt[0].median_minor, 70000);
});

test("deal check: position only with a good tier; otherwise no median and a clear reason; disclaimer always", () => {
  const dir = market();
  const thin = run(["deal", "--component", "GPU", "--name", "RX 6600", "--price", "40000", "--condition", "used"], { dir }).json;
  assert.equal(thin.by_level[0].position, "insufficient_data");
  assert.equal(thin.by_level[0].median_minor, null);
  assert.match(thin.by_level[0].insufficient_note, /need 3 entries from 2 sellers/);
  assert.match(thin.disclaimer, /do not prove a part is genuine or healthy/);

  threeGpu(dir);
  const d = run(["deal", "--component", "GPU", "--name", "RX 6600", "--price", "40000", "--condition", "used", "--level", "local_market", "--text", "urgent, no return, untested"], { dir }).json;
  assert.equal(d.by_level[0].position, "below");
  assert.equal(d.by_level[0].median_minor, 46000);
  assert.deepEqual(d.risk_hits.map((h) => h.term).sort(), ["no return", "untested", "urgent"]);
  assert.ok(d.checklist.length >= 4);
  assert.equal(run(["deal", "--component", "GPU", "--name", "RX 6600", "--price", "40000"], { dir }).json.error.code, "USAGE", "condition has no default");
});

test("levels are never mixed in one statistic", () => {
  const dir = market();
  logRow(dir, { name: "RX 6600", price: 40000, seller: "A", level: "local_market" });
  logRow(dir, { name: "RX 6600", price: 50000, seller: "B", level: "online_domestic" });
  logRow(dir, { name: "RX 6600", price: 60000, seller: "C", level: "online_domestic" });
  const groups = run(["groups"], { dir }).json.groups;
  assert.equal(groups.length, 2);
  assert.ok(groups.every((g) => g.n <= 2));
});

test("export -> fresh import reproduces rows; re-import adds nothing; conflicts keep local", () => {
  const A = market();
  threeGpu(A);
  const file = path.join(tmpDir(), "export.json");
  assert.equal(run(["export", "--out", file], { dir: A }).json.observations, 3);

  const B = market();
  const dry = run(["import", file], { dir: B }).json;
  assert.equal(dry.dry_run, true);
  assert.equal(dry.counts.add, 3);
  assert.equal(run(["list"], { dir: B }).json.total, 0, "dry run writes nothing");
  assert.equal(run(["import", file, "--confirm"], { dir: B }).json.applied.observations, 3);
  assert.equal(run(["latest", "rx 6600"], { dir: B }).json.matches[0].median_minor, 46000);

  const again = run(["import", file, "--confirm"], { dir: B }).json;
  assert.equal(again.counts.add, 0);
  assert.equal(again.counts.identical, 3);
  assert.equal(run(["list"], { dir: B }).json.total, 3);

  const edited = JSON.parse(fs.readFileSync(file, "utf8"));
  edited.observations[0].price = 99999;
  fs.writeFileSync(file, JSON.stringify(edited));
  const c = run(["import", file, "--confirm"], { dir: B }).json;
  assert.equal(c.counts.conflict, 1);
  assert.equal(run(["latest", "rx 6600"], { dir: B }).json.matches[0].median_minor, 46000, "local value kept");
});

test("import refuses wrong country, higher version, and flags broken references; settings are allowlisted", () => {
  const A = market();
  threeGpu(A);
  const file = path.join(tmpDir(), "e.json");
  run(["export", "--out", file], { dir: A });
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));

  const US = market("US");
  const f1 = path.join(path.dirname(file), "pk.json");
  fs.writeFileSync(f1, JSON.stringify(payload));
  assert.match(run(["import", f1], { dir: US }).json.error, /PK\/PKR/);

  const B = market();
  const f2 = path.join(path.dirname(file), "v2.json");
  fs.writeFileSync(f2, JSON.stringify({ ...payload, version: 99 }));
  assert.match(run(["import", f2, "--confirm"], { dir: B }).json.error, /Unsupported export version/);
  assert.equal(run(["list"], { dir: B }).json.total, 0);

  payload.observations[1].correction_of = "00000000-0000-0000-0000-000000000000";
  payload.settings = { min_samples: 4, online_collection_enabled: true, endpoint: "http://evil", api_key: "x" };
  const f3 = path.join(path.dirname(file), "ref.json");
  fs.writeFileSync(f3, JSON.stringify(payload));
  const r = run(["import", f3, "--confirm", "--settings"], { dir: B }).json;
  assert.equal(r.counts.invalid, 1);
  assert.equal(r.counts.add, 2);
  const cfg = JSON.parse(fs.readFileSync(path.join(B, "PK", "config.json"), "utf8"));
  assert.equal(cfg.min_samples, 4);
  assert.deepEqual(Object.keys(cfg).sort(), ["min_samples"], "nothing outside the allowlist is written");
});

test("build totals: partial label until every part is good; matching is exact-first", () => {
  const dir = market();
  threeGpu(dir);
  const r = run(["build", "total", "--preset", "heavy", "--condition", "used"], { dir }).json;
  assert.equal(r.asking_total.all_good, false);
  assert.equal(r.asking_total.priced, 1);
  assert.equal(r.asking_total.parts, 7);
  assert.match(r.asking_total.label, /partial 1\/7/);
  assert.equal(r.asking_total.subtotal_minor, 46000);
  assert.equal(r.sold_total.subtotal_minor, 0);
  assert.equal(r.parts.find((p) => p.component === "CPU").matched, null, "no logged CPU: no data, not zero");
  assert.equal(run(["build", "total", "--preset", "heavy"], { dir }).json.error.code, "USAGE", "condition has no default");
  assert.ok(r.user_checklist.length === 5 && /does not verify compatibility/.test(r.user_checklist_header));
});

test("candidates: queue, human choices required, PKR confirmed as reported/online, foreign stays reference", () => {
  const dir = market();
  const ex = run(["extract", "--text", "Asus Dual RX 6600 8GB Graphics Card – Used\nPrice: Rs. 53,000. Abroad it sells for €178.", "--queue", "--url", "https://example.pk/rx6600"], { dir }).json;
  assert.equal(ex.found.length, 2);
  assert.equal(ex.queued_ids.length, 2);
  assert.equal(run(["list"], { dir }).json.total, 0, "nothing in statistics before confirm");
  const pending = run(["candidates", "list"], { dir }).json.rows;
  const pkr = pending.find((c) => c.currency === "PKR");
  const eur = pending.find((c) => c.currency === "EUR");
  assert.equal(pkr.raw_name, "Asus Dual RX 6600 8GB");

  assert.match(run(["candidates", "confirm", String(pkr.id)], { dir }).json.error.message, /type.*condition|condition.*type/s);
  assert.equal(run(["candidates", "confirm", String(eur.id), "--component", "GPU", "--type", "sold", "--condition", "used"], { dir }).json.error.code, "REFERENCE_ONLY");
  const ok = run(["candidates", "confirm", String(pkr.id), "--component", "GPU", "--type", "asking", "--condition", "used"], { dir }).json;
  assert.equal(ok.record.evidence, "reported");
  assert.equal(ok.record.level, "online_domestic");
  assert.equal(run(["candidates", "list"], { dir }).json.rows.length, 1);
  assert.equal(run(["extract", "--text", "nothing priced here"], { dir }).json.found.length, 0);
});

test("alias merge needs an explicit --confirm and is reversible; unrelated components refused", () => {
  const dir = market();
  threeGpu(dir, "RX 6600", 46000);
  threeGpu(dir, "RX 6600 XT", 70000);
  const alias = "gpu:6600 rx xt";
  const into = "gpu:6600 rx";
  const prev = run(["alias", "merge", "--alias", alias, "--into", into], { dir }).json;
  assert.equal(prev.needs_confirm, true);
  assert.equal(run(["alias", "list"], { dir }).json.aliases.length, 0, "preview changes nothing");
  assert.equal(run(["alias", "merge", "--alias", alias, "--into", into, "--confirm"], { dir }).json.ok, true);
  assert.equal(run(["latest", "rx 6600", "--condition", "used"], { dir }).json.matches[0].n, 6);
  assert.equal(run(["alias", "merge", "--alias", into, "--into", alias, "--confirm"], { dir }).json.error.code, "ALIAS_REFUSED", "cycle refused");
  run(["alias", "unmerge", "--alias", alias], { dir });
  assert.equal(run(["latest", "rx 6600", "--condition", "used"], { dir }).json.matches[0].n, 3, "unmerge reverses");
});

test("backup writes a verified copy once per local day and keeps the log untouched", () => {
  const dir = market();
  threeGpu(dir);
  const first = run(["backup"], { dir }).json;
  assert.ok(fs.existsSync(first.backup));
  assert.equal(first.events, 3);
  assert.equal(run(["backup"], { dir }).json.skipped, true);
  assert.equal(run(["backup", "--force"], { dir, now: "2025-03-01T10:00:05Z" }).json.ok, true);
});

test("bridge: web-app export imports here and this data exports back in the app's format", () => {
  const dir = market();
  const appFile = path.join(tmpDir(), "app.json");
  fs.writeFileSync(appFile, JSON.stringify({
    format: "pc-market-watcher-export", version: 1, exported_at: "2025-02-28T00:00:00Z",
    observations: [
      { uuid: "11111111-1111-4111-8111-111111111111", component: "GPU", raw_name: "RX 6600", item_kind: "single", price_pkr: 45000, price_type: "asking", condition: "used", seller: "Shop A", location: null, location_level: "peshawar_shop", observed_date: "2025-02-20", evidence: "observed", created_at: "2025-02-20T10:00:00Z" },
      { uuid: "22222222-2222-4222-8222-222222222222", component: "GPU", raw_name: "RX 6600", item_kind: "single", price_pkr: 47000, price_type: "asking", condition: "used", seller: "Shop B", location_level: "pakistan_online", observed_date: "2025-02-21", evidence: "reported", created_at: "2025-02-21T10:00:00Z" },
    ],
    model_alias: [], settings: {},
  }));
  assert.equal(run(["import", appFile, "--from-app"], { dir }).json.counts.add, 2);
  run(["import", appFile, "--from-app", "--confirm"], { dir });
  const rows = run(["list"], { dir }).json.rows;
  assert.deepEqual(rows.map((r) => r.level).sort(), ["local_market", "online_domestic"]);

  const out = path.join(tmpDir(), "back.json");
  run(["export", "--as-app", "--out", out], { dir });
  const back = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(back.format, "pc-market-watcher-export");
  assert.deepEqual(back.observations.map((o) => o.price_pkr).sort(), [45000, 47000]);
  assert.deepEqual(back.observations.map((o) => o.location_level).sort(), ["pakistan_online", "peshawar_shop"]);

  const us = market("US");
  assert.equal(run(["export", "--as-app"], { dir: us }).json.error.code, "BRIDGE_MISMATCH");
});

test("works in other currencies: USD cents, KWD millimes, JPY whole units", () => {
  const us = market("US");
  logRow(us, { name: "RTX 3060", price: "289.99", seller: "A" });
  assert.equal(run(["latest", "rtx 3060"], { dir: us, env: {} }).json.matches[0].latest.price_minor, 28999);
  assert.equal(logRow(us, { name: "RTX 3060", price: "289.999", seller: "B" }).json.error.code, "VALIDATION");
  const kw = market("KW");
  assert.equal(logRow(kw, { name: "RTX 3060", price: "89.500", seller: "A" }).json.record.price_minor, 89500);
  const jp = market("JP");
  assert.equal(logRow(jp, { name: "RTX 3060", price: "39800", seller: "A" }).json.record.price_minor, 39800);
});

test("key command explains identity decisions", () => {
  const r = run(["key", "--component", "GPU", "RX6600 8GB", "Sapphire Pulse RX 6600"], { dir: tmpDir() }).json;
  assert.equal(r.same, true);
  assert.equal(run(["key", "--component", "GPU", "RX 6600", "RX 6600 XT"], { dir: tmpDir() }).json.same, false);
});

test("date rollover uses the market's own time zone", () => {
  const dir = market("PK");
  const today = (now) => run(["status"], { dir, now }).json.today;
  assert.equal(today("2025-01-14T18:59:00Z"), "2025-01-14");
  assert.equal(today("2025-01-14T19:00:00Z"), "2025-01-15");
  const inDir = market("IN");
  assert.equal(run(["status"], { dir: inDir, now: "2025-01-14T18:30:00Z" }).json.today, "2025-01-15");
});

test("exit codes: usage errors are 2, runtime errors are 1, success is 0", () => {
  const dir = tmpDir();
  assert.equal(run(["nonsense"], { dir }).code, 2);
  assert.equal(run(["status"], { dir }).code, 1);
  assert.equal(run(["country", "list"], { dir }).code, 0);
});
