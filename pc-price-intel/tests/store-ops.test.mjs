import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeContext } from "../scripts/lib/context.mjs";
import { setActiveCountry } from "../scripts/lib/context.mjs";
import { logObservation, correctObservation, voidObservation, unvoidObservation, overrideSanity, chainOf, findObservation } from "../scripts/lib/observations.mjs";
import { eligibleRows } from "../scripts/lib/stats.mjs";
import { parseLog } from "../scripts/lib/store.mjs";
import { tmpDir } from "./helpers.mjs";

function setup(country = "PK") {
  process.env.PCP_DATA_DIR = tmpDir();
  process.env.PCP_NOW = "2025-03-01T10:00:00Z";
  delete process.env.PCP_COUNTRY;
  setActiveCountry(country);
  return makeContext({});
}
const base = { component: "GPU", name: "RX 6600", type: "asking", condition: "used", level: "local_market" };
const elig = (ctx) => eligibleRows(ctx.store.state(), ctx);

test("price 1 is saved and flagged, never blocked; unknown ranges flag nothing; override makes it eligible", () => {
  const ctx = setup();
  const r = logObservation(ctx, { ...base, price: 1 });
  assert.equal(r.event.sanity_flag, "too_low");
  assert.equal(elig(ctx).length, 0, "flagged row is visible but ineligible");
  assert.equal(ctx.store.state().observations.length, 1);
  overrideSanity(ctx, 1);
  assert.equal(elig(ctx).length, 1);

  const us = setup("US"); // no sanity ranges shipped for US -> unknown -> ok
  assert.equal(logObservation(us, { ...base, price: 1 }).event.sanity_flag, "ok");
});

test("bundles are stored but never in statistics; kits stay separate from singles", () => {
  const ctx = setup();
  logObservation(ctx, { ...base, price: 50000, kind: "bundle", seller: "S" });
  logObservation(ctx, { ...base, price: 50000, kind: "kit", seller: "S2" });
  assert.equal(ctx.store.state().observations.length, 2);
  const rows = elig(ctx);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item_kind, "kit");
});

test("duplicate detection: same seller+model+kind+condition+type+price within 1 day only", () => {
  const ctx = setup();
  logObservation(ctx, { ...base, price: 46000, seller: "Shop A", date: "2025-02-27" });
  assert.equal(logObservation(ctx, { ...base, name: "Sapphire Pulse RX6600 8GB", price: 46000, seller: "shop a", date: "2025-02-28" }).event.duplicate_of !== null, true);
  assert.equal(logObservation(ctx, { ...base, price: 46500, seller: "Shop A", date: "2025-02-28" }).event.duplicate_of, null, "different price kept");
  assert.equal(logObservation(ctx, { ...base, name: "RX 6600 XT", price: 46000, seller: "Shop A", date: "2025-02-28" }).event.duplicate_of, null, "different model");
  assert.equal(logObservation(ctx, { ...base, price: 46000, seller: "Shop B", date: "2025-02-28" }).event.duplicate_of, null, "different seller");
  assert.equal(logObservation(ctx, { ...base, price: 46000, date: "2025-02-27" }).event.duplicate_of, null, "empty seller never auto-flagged");
  assert.equal(logObservation(ctx, { ...base, price: 46000, seller: "Shop A", date: "2025-02-20" }).event.duplicate_of, null, "more than 1 day apart");
});

test("corrections link, originals untouched and ineligible, chains work, void is soft and reversible", () => {
  const ctx = setup();
  const a = logObservation(ctx, { ...base, price: 40000, seller: "S1" }).event;
  const b = correctObservation(ctx, a.id, { price: 42000 }).event;
  const c = correctObservation(ctx, b.id, { price: 43000 }).event;
  const st = ctx.store.state();
  assert.equal(st.byId.get(a.id).price_minor, 40000, "original unchanged");
  assert.deepEqual(chainOf(st, c.id).map((o) => o.id), [a.id, b.id, c.id]);
  const live = elig(ctx);
  assert.deepEqual(live.map((o) => o.id), [c.id]);

  voidObservation(ctx, c.id, "typo");
  assert.equal(elig(ctx).length, 0);
  assert.equal(ctx.store.state().byId.get(c.id).void_reason, "typo");
  unvoidObservation(ctx, c.id);
  assert.equal(elig(ctx).length, 1);
  assert.throws(() => voidObservation(ctx, c.id, ""), /reason/);
  assert.throws(() => findObservation(ctx.store.state(), "9999"), /No observation/);
});

test("validation: no defaults for type/condition, future dates refused, decimals respected", () => {
  const ctx = setup();
  assert.throws(() => logObservation(ctx, { component: "GPU", name: "x", price: 100 }), /type.*condition|condition.*type/s);
  assert.throws(() => logObservation(ctx, { ...base, price: "47k" }), /plain number/);
  assert.throws(() => logObservation(ctx, { ...base, price: 100, date: "2025-03-05" }), /future/);
  assert.throws(() => logObservation(ctx, { ...base, price: 100, component: "TOASTER" }), /component/);
  const us = setup("US");
  assert.equal(logObservation(us, { ...base, price: "1,299.99" }).event.price_minor, 129999);
  assert.throws(() => logObservation(us, { ...base, price: "1.999" }), /decimal/);
});

test("foreign-currency rows are references: stored, never in statistics", () => {
  const ctx = setup();
  const r = logObservation(ctx, { ...base, name: "RX 6600 eBay median", price: 178, currency: "EUR", type: "sold" });
  assert.equal(r.reference_only, true);
  assert.equal(r.event.price_minor, 17800);
  assert.equal(r.event.evidence, "reference");
  assert.equal(elig(ctx).length, 0);
});

test("a torn last line (power cut) is tolerated and quarantined, never silently deleted", () => {
  const ctx = setup();
  logObservation(ctx, { ...base, price: 45000, seller: "A" });
  fs.appendFileSync(ctx.store.file, '{"e":"obs","id":2,"uuid":"half-writ');
  const st = ctx.store.state();
  assert.equal(st.observations.length, 1);
  assert.match(st.warnings.join(" "), /incomplete last line/);
  logObservation(ctx, { ...base, price: 46000, seller: "B" });
  const after = ctx.store.state();
  assert.equal(after.observations.length, 2);
  const aside = fs.readdirSync(ctx.store.dir).filter((f) => f.includes(".torn-"));
  assert.equal(aside.length, 1, "fragment kept for forensics");
  assert.match(fs.readFileSync(`${ctx.store.dir}/${aside[0]}`, "utf8"), /half-writ/);
});

test("corruption in the middle is refused, file untouched", () => {
  assert.throws(() => parseLog('{"e":"obs","id":1}\nnot json\n{"e":"obs","id":2}\n'), (e) => e.code === "CORRUPT_LOG");
  assert.equal(parseLog('{"e":"obs","id":1}\n').events.length, 1);
});
