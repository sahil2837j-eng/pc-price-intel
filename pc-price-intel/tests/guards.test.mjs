import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SKILL_DIR } from "./helpers.mjs";

function walk(dir, ext, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.name === "node_modules") continue;
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, ext, out);
    else if (ext.some((e) => f.name.endsWith(e))) out.push(p);
  }
  return out;
}
const scripts = () => walk(path.join(SKILL_DIR, "scripts"), [".mjs"]);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("the CLI never touches the network or spawns processes", () => {
  const banned = [/\bfetch\s*\(/, /node:https?/, /node:net\b/, /node:dns/, /node:tls/, /node:dgram/, /XMLHttpRequest/, /\bWebSocket\b/, /child_process/, /\beval\s*\(/, /new Function\s*\(/];
  for (const f of scripts()) {
    const code = strip(fs.readFileSync(f, "utf8"));
    for (const re of banned) assert.ok(!re.test(code), `${path.relative(SKILL_DIR, f)} must not contain ${re}`);
  }
});

test("no raw clock reads outside timeutil.mjs (the clock must stay injectable)", () => {
  for (const f of scripts()) {
    if (f.endsWith("timeutil.mjs")) continue;
    const code = strip(fs.readFileSync(f, "utf8"));
    assert.ok(!/Date\.now\s*\(/.test(code), `${path.basename(f)}: Date.now()`);
    assert.ok(!/new Date\s*\(\s*\)/.test(code), `${path.basename(f)}: new Date()`);
  }
});

test("no secrets, keys or endpoints are handled anywhere in the skill", () => {
  const re = /api[_-]?key|secret|bearer|password|authorization/i;
  for (const f of scripts()) assert.ok(!re.test(strip(fs.readFileSync(f, "utf8"))), `${path.basename(f)} mentions credentials`);
});

test("forbidden claims never appear in anything the tool prints", () => {
  // Words that must not be CLAIMED. The only allowed uses are the fixed negative disclaimers.
  const allowedLines = [
    /do not prove a part is genuine or healthy/,
    /does not verify compatibility/,
    /not a price claim/,
    /Software cannot prove/,
    /never claims? /i,
    // A whole line that is just a regex literal is a STRIPPING pattern (it removes marketing words
    // such as "genuine" from collected listing titles); it is never printed as a claim.
    /^\s*\/.*\/[gimsuy]*,?\s*$/,
  ];
  const banned = [/\bguaranteed\b/i, /will drop/i, /will rise/i, /\bgood deal\b/i, /\bscam\b/i, /deal score/i, /\bis safe\b/i, /\bgenuine\b/i, /\bcompatible\b/i];
  // Scan what can be PRINTED: code with comments removed, plus the JSON assets.
  const files = [...scripts(), ...walk(path.join(SKILL_DIR, "assets"), [".json"])];
  for (const f of files) {
    const raw = fs.readFileSync(f, "utf8");
    (f.endsWith(".mjs") ? strip(raw) : raw).split("\n").forEach((line, i) => {
      for (const re of banned) {
        if (re.test(line) && !allowedLines.some((ok) => ok.test(line))) assert.fail(`${path.relative(SKILL_DIR, f)}:${i + 1} contains ${re}: ${line.trim()}`);
      }
    });
  }
});

test("bundled facts carry no prices or invented market statistics", () => {
  // Profiles may hold sanity RANGES (flag thresholds), never observed prices or medians.
  for (const f of walk(path.join(SKILL_DIR, "assets", "profiles"), [".json"])) {
    const txt = fs.readFileSync(f, "utf8");
    assert.ok(!/median|"price"\s*:|price_pkr|"asking_price"/i.test(txt.replace(/"price_type"/g, "")), `${path.basename(f)} must not ship prices`);
  }
  const builds = fs.readFileSync(path.join(SKILL_DIR, "assets", "data", "builds.json"), "utf8");
  assert.ok(!/\b(price|pkr|usd|rs\.?)\s*\d/i.test(builds), "build presets ship without prices");
});

test("user data lives outside the skill folder", () => {
  const paths = fs.readFileSync(path.join(SKILL_DIR, "scripts", "lib", "paths.mjs"), "utf8");
  assert.match(paths, /PCP_DATA_DIR/);
  assert.match(paths, /\.local/);
  assert.ok(!fs.existsSync(path.join(SKILL_DIR, "data")), "no data dir inside the skill");
  assert.ok(!fs.readdirSync(SKILL_DIR).some((f) => f.endsWith(".jsonl")));
});
