import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SKILL_DIR, tmpDir } from "./helpers.mjs";

const INSTALLER = path.resolve(SKILL_DIR, "..", "install.mjs");
const have = fs.existsSync(INSTALLER);

function install(args, { home, cwd = home, env = {} } = {}) {
  return spawnSync(process.execPath, [INSTALLER, ...args], { encoding: "utf8", cwd, env: { ...process.env, HOME: home, USERPROFILE: home, PCP_DATA_DIR: path.join(home, "data"), ...env } });
}

test("installer: default target, replace on re-run, uninstall leaves data alone", { skip: !have && "installer not present in an installed copy" }, () => {
  const home = tmpDir("pcp-home-");
  const dest = path.join(home, ".agents", "skills", "pc-price-intel");
  const r = install([], { home });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(dest, "SKILL.md")));
  assert.ok(fs.existsSync(path.join(dest, "scripts", "pcp.mjs")));

  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.writeFileSync(path.join(home, "data", "keep.txt"), "mine");
  fs.writeFileSync(path.join(dest, "stale.txt"), "old");
  assert.equal(install([], { home }).status, 0);
  assert.ok(!fs.existsSync(path.join(dest, "stale.txt")), "re-install replaces the skill folder");

  // the installed copy runs
  const doc = spawnSync(process.execPath, [path.join(dest, "scripts", "pcp.mjs"), "doctor", "--json"], { encoding: "utf8", env: { ...process.env, PCP_DATA_DIR: path.join(home, "data") } });
  assert.equal(JSON.parse(doc.stdout).ok, true);

  assert.equal(install(["--uninstall"], { home }).status, 0);
  assert.ok(!fs.existsSync(dest));
  assert.equal(fs.readFileSync(path.join(home, "data", "keep.txt"), "utf8"), "mine", "user data untouched");
});

test("installer: per-agent targets, project mode, symlink, dry run, PATH shim", { skip: !have && "installer not present in an installed copy" }, () => {
  const home = tmpDir("pcp-home-");
  assert.equal(install(["--target", "opencode"], { home }).status, 0);
  assert.ok(fs.existsSync(path.join(home, ".config", "opencode", "skills", "pc-price-intel", "SKILL.md")));
  assert.equal(install(["--target", "claude"], { home }).status, 0);
  assert.ok(fs.existsSync(path.join(home, ".claude", "skills", "pc-price-intel", "SKILL.md")));
  assert.equal(install(["--target", "gemini"], { home }).status, 0);
  assert.ok(fs.existsSync(path.join(home, ".gemini", "skills", "pc-price-intel", "SKILL.md")));

  const multi = install(["--target", "agents,claude", "--dry-run"], { home: tmpDir("pcp-home-") });
  assert.match(multi.stdout, /duplicate skill names/);
  assert.match(multi.stdout, /\[dry-run\]/);

  const proj = tmpDir("pcp-proj-");
  assert.equal(install(["--project"], { home, cwd: proj }).status, 0);
  assert.ok(fs.existsSync(path.join(proj, ".agents", "skills", "pc-price-intel", "SKILL.md")));

  const linkHome = tmpDir("pcp-home-");
  const bin = path.join(linkHome, "bin");
  assert.equal(install(["--link", "--bin", bin], { home: linkHome }).status, 0);
  const dest = path.join(linkHome, ".agents", "skills", "pc-price-intel");
  assert.ok(fs.lstatSync(dest).isSymbolicLink());
  if (process.platform !== "win32") {
    const v = spawnSync(path.join(bin, "pcp"), ["version"], { encoding: "utf8" });
    assert.match(v.stdout, /pcp \d+\.\d+\.\d+/);
  }
  assert.equal(install(["--uninstall", "--bin", bin], { home: linkHome }).status, 0);
  assert.ok(!fs.existsSync(dest) && !fs.existsSync(path.join(bin, "pcp")));
});

test("installer refuses to overwrite a different skill with the same folder name", { skip: !have && "installer not present in an installed copy" }, () => {
  const home = tmpDir("pcp-home-");
  const dest = path.join(home, ".agents", "skills", "pc-price-intel");
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "SKILL.md"), "---\nname: something-else\ndescription: x\n---\n");
  const r = install([], { home });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not this skill/);
  assert.equal(install(["--force"], { home }).status, 0);
});
