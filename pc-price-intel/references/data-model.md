# Data model, storage and recovery

## Where data lives
`<data dir>/<CC>/events.jsonl` (the log), `<data dir>/<CC>/config.json` (overrides), `<data dir>/<CC>/backups/`,
`<data dir>/profiles/<CC>.json` (user profiles), `<data dir>/config.json` (active country).
Data dir: `$PCP_DATA_DIR`, else `%LOCALAPPDATA%\pc-price-intel` (Windows), else `$XDG_DATA_HOME/pc-price-intel`,
else `~/.local/share/pc-price-intel`. `pcp doctor` prints it. It is never inside the skill folder, so upgrading or
reinstalling the skill cannot touch it.

## The event log
One JSON object per line, append-only. State is the replay of the log. Originals are never rewritten.

| `e` | Meaning |
| --- | --- |
| `obs` | An observation. Fields: `id`, `uuid`, `ts` (UTC), `component`, `raw_name`, `specs`, `model_key`, `item_kind`, `price_minor`, `currency`, `price_type`, `condition`, `seller`, `seller_key`, `location`, `location_level`, `observed_date`, `evidence`, `warranty`, `source_ref`, `notes`, `sanity_flag`, `duplicate_of`, `correction_of` |
| `void` / `unvoid` | Soft void with `reason` / undo |
| `override` | User verified a flagged price (`value`) |
| `unmark_dup` | User says it is not a duplicate |
| `alias` / `unalias` | Model-group merge / reversal |
| `cand` / `cand_decide` | A review-queue candidate / its decision (`confirmed` with `observation_uuid`, or `discarded`) |

Unknown event types written by a newer version are ignored with a warning.

## Power cuts and corruption
Every write is one append plus an fsync. A power cut can at worst leave one torn last line:
- on read it is ignored and a warning appears in `pcp status`;
- on the next write it is moved to `events.jsonl.torn-<time>` (kept, never deleted) and the log continues.
A bad line in the **middle** is real corruption: commands fail with `CORRUPT_LOG`, nothing is modified, and you must not
edit the file. Restore instead (below).

## Backups and restore
`pcp backup` copies the log to `backups/events-YYYYMMDD-HHMMSS.jsonl`, verifies it reads, keeps the latest 7, and skips if one
already exists for today's local date. To restore: stop using the tool, move the damaged `events.jsonl` aside (do not delete
it), copy a backup to `events.jsonl`, run `pcp status`. For a portable copy use `pcp export --out file.json`.

## Export format (`pc-price-intel-export` v1)
```
{ "format":"pc-price-intel-export", "version":1, "exported_at":"..Z", "country":"PK", "currency":"PKR",
  "observations":[{ "uuid","component","raw_name","specs","item_kind","price" (major units),"currency","price_type","condition",
                    "seller","location","location_level","observed_date","evidence","warranty","source_ref","notes",
                    "sanity_override","duplicate_of","correction_of","voided_at","void_reason","created_at" }],
  "aliases":[{"alias_key","canonical_key"}],
  "settings":{ window_days, min_samples, min_sellers, trend_flat_pct, bands, sanity, extra_* }  }
```
Exports include every row (voided, superseded, duplicates). They never include candidates, keys or network settings.

## Import rules
`pcp import f.json` is a **dry run**: it reports `add`, `identical`, `conflict`, `invalid`. `--confirm` applies it.
- Same uuid and identical user fields: skipped. Re-importing the same file adds nothing.
- Same uuid, different fields: conflict, **local kept**, never overwritten.
- A `duplicate_of` or `correction_of` pointing at an unknown uuid: that row is invalid and skipped.
- Higher or unknown `version`, or a different country/currency than the active market: nothing is imported.
- Model keys and sanity flags are recomputed locally; duplicate, correction and void links are preserved.
- All accepted rows go in with one write. `--settings` also applies the analysis settings in the allowlist; nothing else is ever imported.
