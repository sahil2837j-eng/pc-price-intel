#!/usr/bin/env node
// Installer for the pc-price-intel skill. Zero dependencies, cross-platform (Node >= 18).
//
//   node install.mjs                         install to ~/.agents/skills (opencode, Codex, Gemini CLI read it)
//   node install.mjs --target opencode       ~/.config/opencode/skills
//   node install.mjs --target claude         ~/.claude/skills
//   node install.mjs --target gemini         ~/.gemini/skills
//   node install.mjs --target agents,claude  several (comma list), or --target all
//   node install.mjs --project               install into the current project instead of the home folder
//   node install.mjs --dir /some/skills      explicit skills directory
//   node install.mjs --link                  symlink instead of copy (edits in this repo go live)
//   node install.mjs --bin ~/.local/bin      also create a `pcp` launcher on your PATH
//   node install.mjs --dry-run | --uninstall | --force
//
// User data lives in the data directory, never in the skill folder. Install, upgrade and uninstall never touch it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "pc-price-intel";
const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, SKILL_NAME);

const GLOBAL = {
  agents: [".agents", "skills"],
  opencode: [".config", "opencode", "skills"],
  claude: [".claude", "skills"],
  gemini: [".gemini", "skills"],
};
const PROJECT = {
  agents: [".agents", "skills"],
  opencode: [".opencode", "skills"],
  claude: [".claude", "skills"],
  gemini: [".gemini", "skills"],
};
// opencode scans all three of these, so installing to several can list the same skill name twice.
const OPENCODE_READS = new Set(["agents", "opencode", "claude"]);

function parse(argv) {
  const flags = {};
  const bool = new Set(["project", "link", "dry-run", "uninstall", "force", "help"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument: ${a}`);
    const k = a.slice(2);
    if (bool.has(k)) flags[k] = true;
    else {
      flags[k] = argv[++i];
      if (flags[k] === undefined) throw new Error(`--${k} needs a value`);
    }
  }
  return flags;
}

function dataDirHint() {
  if (process.env.PCP_DATA_DIR) return process.env.PCP_DATA_DIR;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, "pc-price-intel");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "pc-price-intel");
}

function looksLikeOurSkill(dir) {
  try {
    const md = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    return new RegExp(`^name:\\s*${SKILL_NAME}\\s*$`, "m").test(md.slice(0, 600));
  } catch {
    return false;
  }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".DS_Store") continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else {
      fs.copyFileSync(s, d);
      fs.chmodSync(d, fs.statSync(s).mode);
    }
  }
}

function removeExisting(dest, force, log) {
  const st = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isSymbolicLink()) {
    log(`remove symlink ${dest}`);
    fs.rmSync(dest);
    return;
  }
  if (!looksLikeOurSkill(dest) && !force) {
    throw new Error(`${dest} exists but is not this skill. Refusing to overwrite (use --force).`);
  }
  log(`replace ${dest}`);
  fs.rmSync(dest, { recursive: true, force: true });
}

function writeShim(binDir, installedDir, log) {
  fs.mkdirSync(binDir, { recursive: true });
  const cli = path.join(installedDir, "scripts", "pcp.mjs");
  if (process.platform === "win32") {
    const f = path.join(binDir, "pcp.cmd");
    fs.writeFileSync(f, `@echo off\r\nnode "${cli}" %*\r\n`);
    log(`shim ${f}`);
    return f;
  }
  const f = path.join(binDir, "pcp");
  fs.writeFileSync(f, `#!/bin/sh\nexec node "${cli}" "$@"\n`);
  fs.chmodSync(f, 0o755);
  log(`shim ${f}`);
  return f;
}

function main() {
  const flags = parse(process.argv.slice(2));
  if (flags.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 18).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return 0;
  }
  if (!fs.existsSync(path.join(SOURCE, "SKILL.md"))) throw new Error(`Cannot find ${SOURCE}/SKILL.md`);
  const dry = Boolean(flags["dry-run"]);
  const actions = [];
  const log = (m) => actions.push(dry ? `[dry-run] ${m}` : m);

  let targets;
  if (flags.dir) targets = [{ name: "custom", skillsDir: path.resolve(flags.dir) }];
  else {
    const names = !flags.target ? ["agents"] : flags.target === "all" ? Object.keys(GLOBAL) : String(flags.target).split(",").map((s) => s.trim());
    for (const n of names) if (!GLOBAL[n]) throw new Error(`Unknown target "${n}". Use ${Object.keys(GLOBAL).join(", ")}, all, or --dir.`);
    const base = flags.project ? process.cwd() : os.homedir();
    const map = flags.project ? PROJECT : GLOBAL;
    targets = names.map((n) => ({ name: n, skillsDir: path.join(base, ...map[n]) }));
    if (names.filter((n) => OPENCODE_READS.has(n)).length > 1) {
      actions.push("warning: opencode reads agents, opencode and claude skill folders; installing to several can show duplicate skill names. One location is enough.");
    }
  }

  const installed = [];
  for (const t of targets) {
    const dest = path.join(t.skillsDir, SKILL_NAME);
    if (flags.uninstall) {
      if (fs.lstatSync(dest, { throwIfNoEntry: false })) {
        if (!dry) {
          const st = fs.lstatSync(dest);
          if (!st.isSymbolicLink() && !looksLikeOurSkill(dest) && !flags.force) throw new Error(`${dest} is not this skill. Refusing to delete (use --force).`);
          fs.rmSync(dest, { recursive: true, force: true });
        }
        log(`removed ${dest}`);
      } else log(`not installed at ${dest}`);
      continue;
    }
    removeExistingIfAny(dest, flags.force, dry, log);
    if (flags.link) {
      log(`link ${dest} -> ${SOURCE}`);
      if (!dry) {
        fs.mkdirSync(t.skillsDir, { recursive: true });
        fs.symlinkSync(SOURCE, dest, process.platform === "win32" ? "junction" : "dir");
      }
    } else {
      log(`copy ${SOURCE} -> ${dest}`);
      if (!dry) copyDir(SOURCE, dest);
    }
    installed.push(dest);
  }

  if (flags.bin) {
    const binDir = path.resolve(flags.bin);
    if (flags.uninstall) {
      for (const n of ["pcp", "pcp.cmd"]) {
        const f = path.join(binDir, n);
        if (fs.existsSync(f)) {
          if (!dry) fs.rmSync(f);
          log(`removed ${f}`);
        }
      }
    } else if (installed.length) {
      if (!dry) writeShim(binDir, installed[0], log);
      else log(`shim in ${binDir}`);
    }
  }

  for (const a of actions) console.log(a);
  if (!flags.uninstall && installed.length) {
    console.log(`\nInstalled ${SKILL_NAME}. Verify:  node "${path.join(installed[0], "scripts", "pcp.mjs")}" doctor`);
    console.log("Restart your agent (or start a new session) so it re-scans its skills.");
  }
  console.log(`Your price data is kept in ${dataDirHint()} and is never touched by install, upgrade or uninstall.`);
  return 0;
}

function removeExistingIfAny(dest, force, dry, log) {
  if (!fs.lstatSync(dest, { throwIfNoEntry: false })) return;
  if (dry) {
    log(`would replace ${dest}`);
    return;
  }
  removeExisting(dest, force, log);
}

try {
  process.exit(main());
} catch (e) {
  console.error(`install error: ${e.message}`);
  process.exit(1);
}
