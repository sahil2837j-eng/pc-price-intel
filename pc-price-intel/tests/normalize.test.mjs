import test from "node:test";
import assert from "node:assert/strict";
import { buildKey, buildSellerKey, keyMatchesQuery, queryParts } from "../scripts/lib/normalize.mjs";

const key = (c, n) => buildKey(c, n, null);

test("SAME products share one identity key", () => {
  const same = [
    ["GPU", ["RX6600", "rx6600 8GB", "Sapphire Pulse RX6600 8GB", "Radeon RX6600", "RX 6600"]],
    ["CPU", ["i7-4770", "i7 4770", "Intel Core i7 4770"]],
    ["RAM", ["16GB DDR3", "DDR3 16GB"]],
  ];
  for (const [comp, names] of same) {
    const keys = new Set(names.map((n) => key(comp, n)));
    assert.equal(keys.size, 1, `${comp}: ${names.join(" | ")} -> ${[...keys].join(" | ")}`);
  }
});

test("DIFFERENT products stay split (when unsure, split)", () => {
  const diff = [
    ["GPU", "RX580 4GB", "RX580 8GB"],
    ["GPU", "GTX1060 3GB", "GTX1060 6GB"],
    ["GPU", "RX6600", "RX6600 XT"],
    ["GPU", "RTX3060 8GB", "RTX3060 12GB"],
    ["GPU", "RTX3060", "RTX3060 Ti"],
    ["RAM", "DDR3 4GB", "DDR3 8GB"],
    ["RAM", "DDR3 16GB", "DDR4 16GB"],
    ["RAM", "2x8GB DDR4", "16GB DDR4"],
    ["HDD", "1TB", "2TB"],
    ["CPU", "i7-4770", "4770K"],
  ];
  for (const [comp, a, b] of diff) assert.notEqual(key(comp, a), key(comp, b), `${comp}: ${a} vs ${b}`);
});

test("a bare number is never dropped and never-drop tokens survive", () => {
  assert.match(key("GPU", "RTX 3060 Ti"), /\bti\b/);
  assert.match(key("CPU", "Ryzen 5 5600X"), /\bx\b/);
  assert.match(key("GPU", "RX 6600 XT"), /6600/);
});

test("component prefix keeps components apart", () => {
  assert.notEqual(key("GPU", "6600"), key("CPU", "6600"));
});

test("seller keys ignore case and punctuation; empty stays empty", () => {
  assert.equal(buildSellerKey("Al-Noor  Computers"), buildSellerKey("al noor computers"));
  assert.equal(buildSellerKey(""), "");
  assert.equal(buildSellerKey(null), "");
});

test("query matching is order independent and capacity-aware", () => {
  const k = key("GPU", "RX 6600");
  assert.ok(keyMatchesQuery(k, queryParts("6600 rx")));
  assert.ok(keyMatchesQuery(k, queryParts("sapphire pulse rx 6600 8gb")), "capacity ignored when the key dropped it");
  const ram8 = key("RAM", "DDR4 8GB");
  assert.ok(keyMatchesQuery(ram8, queryParts("ddr4 8gb")));
  assert.ok(!keyMatchesQuery(ram8, queryParts("ddr4 16gb")), "capacity must match when the key keeps it");
  assert.ok(!keyMatchesQuery(k, queryParts("rx 580")));
});
