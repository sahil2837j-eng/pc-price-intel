import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SKILL_DIR, run, tmpDir } from "./helpers.mjs";

const md = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");

/** Minimal frontmatter reader: top-level `k: v` and one nested map level. */
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, "SKILL.md must start with YAML frontmatter");
  const out = {};
  let nested = null;
  for (const line of m[1].split("\n")) {
    const top = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    const sub = line.match(/^\s{2}([A-Za-z][\w-]*):\s*(.*)$/);
    if (top) {
      if (top[2] === "") {
        out[top[1]] = {};
        nested = top[1];
      } else {
        out[top[1]] = { raw: top[2] };
        nested = null;
      }
    } else if (sub && nested) {
      out[nested][sub[1]] = { raw: sub[2] };
    } else assert.fail(`Unparseable frontmatter line: ${line}`);
  }
  return { fm: out, body: text.slice(m[0].length) };
}
const unquote = (s) => s.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");

test("frontmatter satisfies the Agent Skills specification", () => {
  const { fm } = frontmatter(md);
  const name = unquote(fm.name.raw);
  assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(name.length >= 1 && name.length <= 64);
  assert.equal(name, path.basename(SKILL_DIR), "name must match the directory name");

  const desc = fm.description.raw;
  const d = unquote(desc);
  assert.ok(d.length >= 1 && d.length <= 1024, `description length ${d.length}`);
  if (!/^["']/.test(desc)) {
    assert.ok(!/: /.test(desc) && !/ #/.test(desc), "plain-scalar description must not contain ': ' or ' #' (breaks YAML parsers)");
  }
  for (const word of ["Use when", "log", "median", "country"]) assert.ok(d.includes(word), `description should mention "${word}" so agents can choose the skill`);

  assert.ok(unquote(fm.compatibility.raw).length <= 500, "compatibility <= 500 chars");
  assert.equal(unquote(fm.license.raw), "MIT");
  assert.ok(fm.metadata && Object.keys(fm.metadata).length > 0, "metadata map present");
  for (const [k, v] of Object.entries(fm.metadata)) assert.match(v.raw, /^".*"$/, `metadata.${k} must be a quoted string`);
});

test("SKILL.md body stays short enough for progressive disclosure", () => {
  const lines = md.split("\n").length;
  assert.ok(lines < 500, `SKILL.md has ${lines} lines (limit 500)`);
  assert.ok(md.length < 20000, "keep the activation payload small (< ~5000 tokens)");
});

test("every relative link in SKILL.md resolves, and every reference file is linked", () => {
  const links = [...md.matchAll(/\]\(([^)#\s]+)\)/g)].map((m) => m[1]).filter((l) => !/^[a-z]+:/i.test(l));
  assert.ok(links.length >= 8);
  for (const l of links) assert.ok(fs.existsSync(path.join(SKILL_DIR, l)), `broken link: ${l}`);
  for (const f of fs.readdirSync(path.join(SKILL_DIR, "references"))) assert.ok(links.includes(`references/${f}`), `references/${f} is not linked from SKILL.md`);
});

test("docs and CLI agree: every pcp command in the docs exists; every command is documented", () => {
  const help = run(["help"], { dir: tmpDir() }).json;
  const commands = new Set(help.commands);
  const docs = ["SKILL.md", ...fs.readdirSync(path.join(SKILL_DIR, "references")).map((f) => `references/${f}`)];
  for (const f of docs) {
    const text = fs.readFileSync(path.join(SKILL_DIR, f), "utf8");
    for (const m of text.matchAll(/`pcp ([a-z][a-z-]*)/g)) {
      assert.ok(commands.has(m[1]) || ["help", "version"].includes(m[1]), `${f} mentions unknown command "pcp ${m[1]}"`);
    }
  }
  const ref = fs.readFileSync(path.join(SKILL_DIR, "references", "commands.md"), "utf8");
  for (const c of commands) if (!["help", "version"].includes(c)) assert.ok(new RegExp(`pcp ${c}\\b`).test(ref), `commands.md does not document "pcp ${c}"`);
});

test("every flag shown in SKILL.md examples is accepted by the CLI parser", () => {
  const known = new Set(["json", "confirm", "settings", "force", "help", "all", "queue", "voided", "duplicates", "flagged", "from-app", "as-app", "stdin", "compat", "preview", "list", "off",
    "country", "currency", "tz", "market", "label", "component", "name", "price", "type", "condition", "level", "kind", "specs", "seller", "location", "date", "warranty", "notes", "evidence", "source", "url", "text", "text-file", "file", "pattern", "preset", "set", "out", "reason", "alias", "into", "group", "status", "model", "from", "to", "page", "limit", "quote"]);
  for (const m of md.matchAll(/--([a-z][a-z-]*)/g)) assert.ok(known.has(m[1]), `SKILL.md uses unknown flag --${m[1]}`);
});

test("evals are well-formed and ids are unique", () => {
  const evals = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, "evals", "evals.json"), "utf8"));
  assert.ok(evals.length >= 6);
  const ids = new Set();
  for (const e of evals) {
    assert.ok(e.id && e.prompt && e.expected_output && Array.isArray(e.assertions) && e.assertions.length > 0, e.id);
    assert.ok(!ids.has(e.id), `duplicate eval id ${e.id}`);
    ids.add(e.id);
  }
});

test("all bundled JSON assets parse", () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".json") ? [path.join(d, e.name)] : []));
  for (const f of walk(path.join(SKILL_DIR, "assets"))) JSON.parse(fs.readFileSync(f, "utf8"));
});
