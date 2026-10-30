import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../scripts/lib/consts.mjs";
import { loadProfile } from "../scripts/lib/profiles.mjs";
import { computeTier, computeTrend, neededForGood, pricePosition } from "../scripts/lib/stats.mjs";

const cfg = DEFAULT_CONFIG;
const TODAY = "2025-03-01";
const row = (price, seller, date) => ({ price_minor: price, seller_key: seller, observed_date: date });

test("good needs enough rows AND enough distinct sellers inside the window", () => {
  const good = computeTier([row(100, "a", "2025-02-20"), row(110, "b", "2025-02-21"), row(120, "c", "2025-02-22")], cfg, TODAY);
  assert.equal(good.tier, "good");
  assert.equal(good.median_minor, 110);
  const oneSeller = computeTier([row(100, "a", "2025-02-20"), row(110, "a", "2025-02-21"), row(120, "a", "2025-02-22")], cfg, TODAY);
  assert.equal(oneSeller.tier, "weak");
  assert.equal(oneSeller.sellers, 1);
});

test("empty sellers are never counted", () => {
  const t = computeTier([row(100, null, "2025-02-20"), row(110, "", "2025-02-21"), row(120, null, "2025-02-22")], cfg, TODAY);
  assert.equal(t.sellers, 0);
  assert.equal(t.tier, "weak");
});

test("only-old rows are stale and labelled as an all-time reference; nothing is none", () => {
  const stale = computeTier([row(100, "a", "2024-01-01"), row(110, "b", "2024-01-02"), row(120, "c", "2024-01-03")], cfg, TODAY);
  assert.equal(stale.tier, "stale");
  assert.equal(stale.all_time_reference, true);
  assert.equal(computeTier([], cfg, TODAY).tier, "none");
  assert.equal(computeTier([], cfg, TODAY).median_minor, null);
});

test("needs-label is computed, not guessed", () => {
  assert.equal(neededForGood(1, 1, cfg), "Needs 1 more seller and 2 more entries to reach good tier.");
  assert.equal(neededForGood(2, 2, cfg), "Needs 1 more entry to reach good tier.");
  assert.equal(neededForGood(3, 2, cfg), null);
});

test("price position bands, and no invented median when tier is not good", () => {
  const good = { tier: "good", median_minor: 100 };
  const at = (p) => pricePosition(p, good, cfg.bands).position;
  assert.equal(at(70), "much_below");
  assert.equal(at(89), "below");
  assert.equal(at(100), "typical");
  assert.equal(at(110), "typical");
  assert.equal(at(111), "above");
  assert.equal(at(130), "much_above");
  const weak = pricePosition(100, { tier: "weak", median_minor: 100 }, cfg.bands);
  assert.equal(weak.position, "insufficient_data");
  assert.equal(weak.ratio, null);
});

test("trend needs 2+ rows in BOTH windows; direction uses the flat threshold", () => {
  const profile = loadProfile("PK");
  const cur = [row(1000, "a", "2025-02-20"), row(1000, "b", "2025-02-25")];
  const prevSame = [row(1000, "a", "2025-01-20"), row(1000, "b", "2025-01-25")];
  const flat = computeTrend([...cur, ...prevSame], cfg, TODAY, "X", profile);
  assert.ok(flat.eligible);
  assert.equal(flat.direction, "flat");
  assert.equal(flat.change_pct, 0);

  const prevLow = [row(800, "a", "2025-01-20"), row(800, "b", "2025-01-25")];
  const up = computeTrend([...cur, ...prevLow], cfg, TODAY, "X", profile);
  assert.equal(up.direction, "up");
  assert.equal(up.change_pct, 25);
  assert.match(up.statement, /rose 25%/);

  const smallMove = computeTrend([row(1020, "a", "2025-02-20"), row(1020, "b", "2025-02-25"), ...prevSame], cfg, TODAY, "X", profile);
  assert.equal(smallMove.direction, "flat"); // 2.0% < 3.0%

  const thin = computeTrend([...cur, row(900, "a", "2025-01-20")], cfg, TODAY, "X", profile);
  assert.equal(thin.eligible, false);
  assert.equal(thin.statement, null);
  assert.equal(thin.direction, null);
});
