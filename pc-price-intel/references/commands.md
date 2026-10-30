# Command reference

`pcp` = `node <skill folder>/scripts/pcp.mjs`. Add `--json` for machine output:
`{"ok":true, ...}` on success, `{"ok":false,"error":{"code","message","hint","details"}}` on failure.
Exit codes: `0` ok, `1` runtime or validation error, `2` usage error.
Global flag: `--country XX` overrides the active country for one command (also `PCP_COUNTRY`).
Environment: `PCP_DATA_DIR` (data location), `PCP_NOW` (pin the clock, ISO UTC), `PCP_COUNTRY`.

Money: every `*_minor` field is an integer in minor units (PKR has 0 decimals, USD 2, KWD 3) and has a
`*_text` sibling such as `"PKR 46,000"`. Quote the text; never convert units yourself.

## Setup and info

| Command | Purpose |
| --- | --- |
| `pcp init --country XX [--currency AAA --tz Area/City] [--market "name"] [--label "name"]` | Activate a market. Extra flags are needed only for countries not in `country list`. Returns `markets`, `online_sources`, `local_terms`, `search_queries`, `notes`, `verified`, `next_steps` |
| `pcp country list` / `pcp country show [XX]` | Known countries (`rich_profile` = curated facts) / full effective profile |
| `pcp status` | Active market, today's local date, counts, groups, good groups, newest entry age, pending candidates, config, warnings |
| `pcp doctor` | Node version, ICU time zones, data dir writable, active country, event log readable |
| `pcp profile show|export` / `pcp profile import <file>` | Read the effective profile / save a validated user profile (stored in the data dir) |
| `pcp config show` | Effective settings |
| `pcp config set <key> <value>` | `window_days`, `min_samples`, `min_sellers`, `trend_flat_pct`, `bands.much_below|below|above|much_above`, `timezone`, `home_market`, `extra_vendor_words`, `extra_subbrand_words`, `extra_capacity_redundant`, `extra_risk_terms` (`"term:severity,..."`) |
| `pcp config sanity <COMPONENT> <min> <max>` | Flag range in major units. A sanity range, not a price claim |
| `pcp config reset [key]` | Remove overrides (`bands.below`, `sanity.GPU`, or everything) |

Defaults: window 30 days, good tier needs 3 entries from 2 distinct sellers, flat trend under 3 %, bands
0.70 / 0.90 / 1.10 / 1.30.

## Recording

`pcp log --component C --name "..." --price N --type asking|sold --condition new|used|refurbished|unknown [--level local_market|online_domestic|other_domestic|unknown] [--kind single|kit|bundle] [--specs ..] [--seller ..] [--location ..] [--date YYYY-MM-DD] [--warranty ..] [--notes ..] [--evidence observed|reported|reference] [--source <ref/url>] [--currency AAA]`

- Components: `GPU CPU RAM MOTHERBOARD PSU SSD HDD CASE COOLER OTHER`.
- Price: plain number, separators of the market allowed (`47,000`), decimals only as the currency allows. `47k`, `1.5 lakh`,
  signs and words are refused.
- `type` and `condition` are required (no defaults). `level` defaults to `unknown`, so always pass it.
- A currency different from the market's currency is stored as a `reference` row and never enters statistics.
- Output: `record`, `duplicate_of`, `reference_only`, `group {tier,n,sellers,median_minor,needs}`.

| Command | Purpose |
| --- | --- |
| `pcp correct <id\|uuid-prefix> [any log flag]` | New linked row; the original is unchanged and becomes ineligible |
| `pcp void <id> --reason ".."` / `pcp unvoid <id>` | Soft void (reason required) and undo |
| `pcp unmark-dup <id>` | The user says a flagged duplicate is not one |
| `pcp override <id>` | The user verified a flagged price (`--off` to undo) |
| `pcp chain <id>` | Original, then each correction |
| `pcp list [--component --model --seller --level --condition --type --from --to --voided --duplicates --flagged --page --limit]` | Rows, newest first, max 50 per page, each with `status` (active, corrected, voided, duplicate, reference) |

## Reading

| Command | Notes |
| --- | --- |
| `pcp latest "<model>" [--component --condition --type --level --kind]` | Exact identity first, token matching as fallback. `type` defaults to `asking`, `kind` to `single`. Returns matches with `tier`, `n`, `sellers`, `median_minor`, `median_is_all_time_reference`, `newest_date`, `needs`, `latest`, `trend` |
| `pcp trend "<model>"` or `pcp trend --group <group_id>` | Trend per matched group: `eligible`, `direction` (up/down/flat), `change_pct`, medians, a code-written `statement`, `low_confidence` when n < 6 |
| `pcp groups [--component --level --condition --type]` | Every group sorted closest to good tier first |
| `pcp deal --component C --name N --price P --condition X [--level L] [--text ".."] [--text-file f]` | `by_level[]` (one line per level that has data), `risk_hits[]` with verbatim quotes, `checklist`, `price_quality_caution` (PSU, motherboard), `disclaimer`. Median is `null` unless the tier is good |
| `pcp checklist <COMPONENT>` / `pcp checklist --compat` | The fixed in-person checklist / the compatibility list the **user** ticks |
| `pcp key --component C "name a" ["name b"]` | Show identity keys and whether two names are the same group |

Group ids look like `gpu:6600 rx|single|used|asking|local_market`.

## Builds

| Command | Notes |
| --- | --- |
| `pcp build list` | Light, Heavy, Beast starting ideas |
| `pcp build template <name>` | JSON spec you can edit and pass back with `--file` |
| `pcp build total --preset <name> --condition C [--set COMP="model text"]...` or `--file spec.json --condition C` | `asking_total` and `sold_total` each with `all_good`, `priced`, `parts`, `subtotal_minor`, `label`. Per part: `matched`, `alternatives`, level used, tier |

Spec file: `{"name":"mine","parts":[{"component":"GPU","label":"..","match":"rx 6600","qty":1}]}`.

## Collection

| Command | Notes |
| --- | --- |
| `pcp extract (--text ".." \| --file f \| --stdin) [--queue] [--source s --url u --name n --component C --pattern "regex"]` | Finds prices that appear verbatim, with quotes. HTML is reduced to text. `--pattern` is a regex with ONE capture group for the number. Without `--queue` nothing is stored |
| `pcp candidates list [--status pending\|confirmed\|discarded]` | The review queue |
| `pcp candidates add --name n --price p [--currency --component --type --condition --quote --url --source --seller --location --evidence --level]` or `--file rows.json` | Queue structured rows (max 50). `seller`/`location` are preserved for distinct-seller tiering; `evidence reference` marks a benchmark row |
| `pcp candidates confirm <id> --component C --type T --condition X [--level L --date D --name N --seller S --location L --evidence reported\\|reference]` | Saves an observation. Defaults to evidence `reported`, level `online_domestic`; a foreign-currency row requires `--evidence reference` |
| `pcp candidates discard <id>` | Drop it |

Optional one-page collector (separate from the core CLI; explicit invocation only):

`node <skill folder>/tools/collect.mjs <olx|amazon|daraz|alibaba> ...`

- `olx`: one public search page; seller is not on the search card, so pass `--seller` at confirm time.
- `amazon`: one public search page; reference-only by default (excluded from statistics).
- `daraz`: manual saved JSON only; robots.txt disallows `/catalog/`.
- `alibaba`: product-detail page only; search `/trade/` is disallowed and CAPTCHA-protected; wholesale/MOQ reference only.
- The collector queues candidates and prints rows; it never confirms. Use `--queue` explicitly.

## Data and identity

| Command | Notes |
| --- | --- |
| `pcp backup [--force]` | Verified copy of the event log into `<data>/<CC>/backups/`, once per local day, keeps 7 |
| `pcp export [--out f] [--as-app]` | Export JSON; `--as-app` writes the PC Market Watcher web-app format (PKR only) |
| `pcp import <f> [--from-app] [--confirm] [--settings]` | Dry run by default. See `references/data-model.md` |
| `pcp alias list` / `suggest` | Existing merges / display-only suggestions |
| `pcp alias merge --alias <key> --into <key> [--confirm]` | Without `--confirm` it only previews the median change |
| `pcp alias unmerge --alias <key>` | Reverse |

## Error codes
See `references/troubleshooting.md`.
