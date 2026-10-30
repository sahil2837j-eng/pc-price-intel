import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.resolve(here, "..");
export const CLI = path.join(SKILL_DIR, "scripts", "pcp.mjs");

export function tmpDir(prefix = "pcp-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Run the real CLI as a subprocess against an isolated data dir. Always asks for JSON. */
export function run(args, { dir, now = "2025-03-01T10:00:00Z", env = {} } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--json"], {
    encoding: "utf8",
    env: { ...process.env, PCP_DATA_DIR: dir, PCP_NOW: now, PCP_COUNTRY: "", ...env },
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* leave null; tests will assert */
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

export function logRow(dir, { name, price, seller, level = "local_market", type = "asking", condition = "used", component = "GPU", date, extra = [] }) {
  const args = ["log", "--component", component, "--name", name, "--price", String(price), "--type", type, "--condition", condition, "--level", level, ...extra];
  if (seller) args.push("--seller", seller);
  if (date) args.push("--date", date);
  return run(args, { dir });
}
