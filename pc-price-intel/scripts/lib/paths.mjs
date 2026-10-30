import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Root of the installed skill folder (the directory that contains SKILL.md). */
export function skillRoot() {
  return path.resolve(here, "..", "..");
}

export function assetsDir() {
  return path.join(skillRoot(), "assets");
}

/**
 * Where user data lives. Never inside the skill folder, so reinstalling or
 * upgrading the skill cannot touch it.
 *   1. PCP_DATA_DIR
 *   2. %LOCALAPPDATA%\pc-price-intel (Windows) or $XDG_DATA_HOME/pc-price-intel
 *      or ~/.local/share/pc-price-intel
 */
export function dataRoot() {
  if (process.env.PCP_DATA_DIR) return path.resolve(process.env.PCP_DATA_DIR);
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "pc-price-intel");
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "pc-price-intel");
}

export function countryDir(cc) {
  return path.join(dataRoot(), cc.toUpperCase());
}

export function customProfileDir() {
  return path.join(dataRoot(), "profiles");
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Atomic JSON write: temp file, fsync, rename. */
export function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

const cache = new Map();
/** Load a bundled JSON asset (assets/data/<name>.json), cached. */
export function loadAsset(rel) {
  if (!cache.has(rel)) {
    cache.set(rel, JSON.parse(fs.readFileSync(path.join(assetsDir(), rel), "utf8")));
  }
  return cache.get(rel);
}
