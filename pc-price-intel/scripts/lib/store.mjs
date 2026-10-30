// Append-only event log: <data>/<CC>/events.jsonl, one JSON object per line.
//
//  * Originals are never rewritten. A correction is a new "obs" with correction_of.
//    A void is a "void" event. State = replay of the log.
//  * Each append is a single write + fsync, so a power cut (load shedding!) can at worst
//    leave ONE torn final line. A torn tail is ignored on read and moved aside (never
//    silently deleted) on the next write. A bad line in the middle is real corruption:
//    refuse to guess and tell the user.
//  * One writer at a time is assumed (one agent session). Appends use O_APPEND.

import fs from "node:fs";
import path from "node:path";
import { resolveKey } from "./alias.mjs";
import { PcpError } from "./errors.mjs";
import { countryDir, ensureDir } from "./paths.mjs";
import { isoUtc, nowUtc } from "./timeutil.mjs";

export function parseLog(text, file = "events.jsonl") {
  const lines = text.split("\n");
  const events = [];
  const warnings = [];
  let lastNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].trim()) lastNonEmpty = i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      if (i === lastNonEmpty) {
        warnings.push(`Ignored an incomplete last line in ${file} (likely a power cut mid-write). It will be moved aside on the next write.`);
      } else {
        throw new PcpError(
          "CORRUPT_LOG",
          `${file} line ${i + 1} is not valid JSON and is not the last line.`,
          "Do not edit or delete the file. Restore from a backup (`pcp export` files) or ask the user. Original left untouched.",
          { file, line: i + 1 },
        );
      }
    }
  }
  return { events, warnings };
}

export function replay(events) {
  const st = {
    observations: [],
    byUuid: new Map(),
    byId: new Map(),
    aliases: new Map(),
    candidates: [],
    candById: new Map(),
    maxId: 0,
    maxCandId: 0,
    warnings: [],
  };
  for (const ev of events) {
    switch (ev.e) {
      case "obs": {
        const { e, ...rest } = ev;
        const o = { ...rest, voided_at: null, void_reason: null, sanity_override: false, duplicate_of: rest.duplicate_of ?? null };
        st.observations.push(o);
        st.byUuid.set(o.uuid, o);
        st.byId.set(o.id, o);
        st.maxId = Math.max(st.maxId, o.id);
        break;
      }
      case "void": {
        const o = st.byUuid.get(ev.uuid);
        if (o) {
          o.voided_at = ev.ts;
          o.void_reason = ev.reason ?? null;
        }
        break;
      }
      case "unvoid": {
        const o = st.byUuid.get(ev.uuid);
        if (o) {
          o.voided_at = null;
          o.void_reason = null;
        }
        break;
      }
      case "override": {
        const o = st.byUuid.get(ev.uuid);
        if (o) o.sanity_override = Boolean(ev.value);
        break;
      }
      case "unmark_dup": {
        const o = st.byUuid.get(ev.uuid);
        if (o) o.duplicate_of = null;
        break;
      }
      case "alias":
        st.aliases.set(ev.alias_key, ev.canonical_key);
        break;
      case "unalias":
        st.aliases.delete(ev.alias_key);
        break;
      case "cand": {
        const { e, ...rest } = ev;
        const c = { ...rest, status: "pending", observation_uuid: null, decided_at: null };
        st.candidates.push(c);
        st.candById.set(c.id, c);
        st.maxCandId = Math.max(st.maxCandId, c.id);
        break;
      }
      case "cand_decide": {
        const c = st.candById.get(ev.id);
        if (c) {
          c.status = ev.status;
          c.observation_uuid = ev.observation_uuid ?? null;
          c.decided_at = ev.ts;
        }
        break;
      }
      default:
        st.warnings.push(`Unknown event type "${ev.e}" ignored (written by a newer version?).`);
    }
  }
  st.resolve = (k) => resolveKey(st.aliases, k);
  return st;
}

export class Store {
  constructor(cc) {
    this.cc = cc;
    this.dir = countryDir(cc);
    this.file = path.join(this.dir, "events.jsonl");
  }

  exists() {
    return fs.existsSync(this.file);
  }

  readEvents() {
    if (!this.exists()) return { events: [], warnings: [] };
    return parseLog(fs.readFileSync(this.file, "utf8"), this.file);
  }

  state() {
    const { events, warnings } = this.readEvents();
    const st = replay(events);
    st.warnings.unshift(...warnings);
    st.eventCount = events.length;
    return st;
  }

  /** Make the file safe to append to: end with a newline; quarantine a torn tail. */
  #repairTail() {
    if (!this.exists()) return;
    const buf = fs.readFileSync(this.file);
    if (buf.length === 0 || buf[buf.length - 1] === 0x0a) return;
    const lastNl = buf.lastIndexOf(0x0a);
    const tail = buf.subarray(lastNl + 1).toString("utf8");
    try {
      JSON.parse(tail);
      fs.appendFileSync(this.file, "\n"); // complete JSON, only the newline was lost
    } catch {
      const aside = `${this.file}.torn-${nowUtc().getTime()}`;
      fs.writeFileSync(aside, tail);
      fs.truncateSync(this.file, lastNl + 1);
    }
  }

  /** Append events atomically-enough: one write, one fsync. */
  append(events) {
    if (!events.length) return;
    ensureDir(this.dir);
    this.#repairTail();
    const data = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const fd = fs.openSync(this.file, "a");
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}

export function ev(type, fields = {}) {
  return { e: type, ts: isoUtc(), ...fields };
}
