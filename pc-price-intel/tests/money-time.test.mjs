import test from "node:test";
import assert from "node:assert/strict";
import { currencyDecimals, fmtMoney, medianMinor, parsePriceInput, roundHalfUp, toMinor } from "../scripts/lib/money.mjs";
import { loadProfile } from "../scripts/lib/profiles.mjs";
import { addDays, daysBetween, isDateString, localDate } from "../scripts/lib/timeutil.mjs";

test("medians are whole minor units, half-up", () => {
  assert.equal(medianMinor([100, 101]), 101); // 100.5 -> 101
  assert.equal(medianMinor([100, 101, 102]), 101);
  assert.equal(medianMinor([5]), 5);
  assert.equal(medianMinor([]), null);
  assert.equal(roundHalfUp(2.5), 3);
});

test("currency decimals come from the platform, so any currency works", () => {
  assert.equal(currencyDecimals("PKR"), 0);
  assert.equal(currencyDecimals("JPY"), 0);
  assert.equal(currencyDecimals("USD"), 2);
  assert.equal(currencyDecimals("KWD"), 3);
  assert.throws(() => currencyDecimals("ZZZ9"), /Unknown ISO 4217/);
});

test("price parsing: separators ok, shorthand and junk refused", () => {
  const pk = loadProfile("PK");
  const us = loadProfile("US");
  assert.equal(parsePriceInput("47,000", pk), 47000);
  assert.equal(parsePriceInput(" 47000 ", pk), 47000);
  assert.equal(parsePriceInput("1,299.99", us), 1299.99);
  for (const bad of ["47k", "1.5 lakh", "-5", "abc", "", "Rs 5000"]) assert.throws(() => parsePriceInput(bad, pk), /Price/, bad);
  assert.equal(toMinor(1299.99, 2), 129999);
  assert.throws(() => toMinor(1.005, 2), /decimal place/);
  assert.throws(() => toMinor(10.5, 0), /decimal place/);
});

test("money formatting uses the profile currency", () => {
  assert.equal(fmtMoney(46000, loadProfile("PK")), "PKR 46,000");
  assert.equal(fmtMoney(129999, loadProfile("US")), "USD 1,299.99");
  assert.equal(fmtMoney(null, loadProfile("PK")), "no data");
});

test("local date rolls over at local midnight (PKT = UTC+5, IST = UTC+5:30)", () => {
  assert.equal(localDate(new Date("2025-01-14T18:59:00Z"), "Asia/Karachi"), "2025-01-14");
  assert.equal(localDate(new Date("2025-01-14T19:00:00Z"), "Asia/Karachi"), "2025-01-15");
  assert.equal(localDate(new Date("2025-01-14T18:29:00Z"), "Asia/Kolkata"), "2025-01-14");
  assert.equal(localDate(new Date("2025-01-14T18:30:00Z"), "Asia/Kolkata"), "2025-01-15");
  assert.equal(localDate(new Date("2025-07-01T03:59:00Z"), "America/New_York"), "2025-06-30"); // DST aware
});

test("date helpers", () => {
  assert.equal(daysBetween("2025-01-01", "2025-01-31"), 30);
  assert.equal(addDays("2025-01-31", 1), "2025-02-01");
  assert.ok(isDateString("2025-02-28"));
  assert.ok(!isDateString("2025-02-30"));
  assert.ok(!isDateString("14-01-2025"));
});
