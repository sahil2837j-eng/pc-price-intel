---
name: pc-price-intel
description: Country-agnostic price intelligence for new and used PC parts (GPU, CPU, RAM, motherboard, PSU, SSD, HDD, case, cooler) in any market. Use when the user wants to log a price they saw or were quoted, find the latest price or median for a part, check whether an asking price is typical, compare Light, Heavy or Beast builds, pull prices out of pasted or fetched listings, or keep an auditable local price history. The agent picks the user's country once (currency, time zone, markets and sources come from a profile) and a zero-dependency Node CLI does all arithmetic, so numbers are never guessed. Never predicts prices, never claims a part is genuine or safe, and collected prices wait for human confirmation.
license: MIT
compatibility: Requires Node.js 18 or newer with no npm dependencies. The CLI makes no network requests and works offline; the agent's own search, fetch or browser tools do any web collection. User data is stored outside the skill folder.
metadata:
  version: "1.0.0"
  scope: "global, country chosen at runtime"
  cli: "scripts/pcp.mjs"
  standard: "Agent Skills (SKILL.md)"
---

# PC Price Intel

A buyer's notebook with arithmetic attached. The user tells you prices they saw or were quoted
(shop, market stall, WhatsApp, classifieds); the **CLI** normalises the model identity, flags duplicates and
odd prices, and computes medians, tiers, trends and build totals. **You never compute or estimate a price.**
You choose the market, call the CLI, and explain what it returned.

`pcp` below means `node <this skill's folder>/scripts/pcp.mjs`. If you cannot resolve the folder, run
`find ~/.config/opencode/skills ~/.claude/skills ~/.agents/skills ~/.gemini/skills ~/.codex/skills -name pcp.mjs`.
Always add `--json`. Every money field comes as `x_minor` (integer minor units) plus `x_text` (quote this one).

| It is | It is not |
| --- | --- |
| A local price log with instant feedback (tier, median, "needs N more sellers") | A price predictor. It never forecasts |
| An identity normaliser (`RX6600 8GB` = `Sapphire Pulse RX 6600`) | A scraper. The CLI has no network code at all |
| A median / tier / trend / build-total calculator | An authenticity checker. "Genuine" and "safe" are banned claims |
| A review queue for prices collected online | A seller messenger, auto-buyer, or listing poster |

## Step 0. Pick the market (once, before anything else)

1. Run `pcp status --json`. If it works, a market is already active: tell the user in one line
   ("Using Pakistan, PKR, Asia/Karachi") and continue.
2. If it returns `NO_COUNTRY`, work out the user's country from what they said (city, shop names, currency,
   language). If it is not obvious, **ask one question**: "Which country are you buying in?" Do not guess silently.
3. `pcp country list --json`. If the country is listed run
   `pcp init --country <ISO2> --market "<city or market>"`. If not, look up the ISO 4217 currency and IANA
   time zone and run `pcp init --country <ISO2> --currency <AAA> --tz <Area/City>`. Any country works.
4. Read the `init` output: `markets`, `online_sources`, `local_terms`, `notes`, `verified`. Those facts are
   **starting points**, not truth: re-check them live before relying on them (see `references/market-profiles.md`).
   Countries with no curated profile get a generated one (currency, time zone, price markers only).
5. Several countries? Pass `--country XX` per command. Data is kept per country and currencies are never mixed.

## Core commands

| Goal | Command |
| --- | --- |
| Log a price | `pcp log --component GPU --name "Sapphire Pulse RX 6600 8GB" --price 53000 --type asking --condition used --level local_market --seller "<shop>" --json` |
| Latest price + tier + trend | `pcp latest "RX 6600 8GB" --condition used --json` |
| Is this price typical? | `pcp deal --component GPU --name "RX 6600" --price 48000 --condition used --level local_market --text "<listing text>" --json` |
| All groups, closest to good tier first | `pcp groups --json` |
| Compare builds | `pcp build total --preset heavy --condition used --set GPU="rx 6600" --json` |
| Extract prices from text | `pcp extract --stdin --queue --source <where> --url <url> --name "<model>" --json` |
| Review collected rows | `pcp candidates list` then `pcp candidates confirm <id> --component .. --type .. --condition ..` |
| Fix or undo | `pcp correct <id> --price N`, `pcp void <id> --reason ".."`, `pcp unvoid <id>`, `pcp chain <id>` |
| Back up / move data | `pcp backup`, `pcp export --out f.json`, `pcp import f.json` (dry run), `--confirm` |

Full flags and output shapes: `references/commands.md`. Levels are `local_market` (in person or by phone at the
user's home market), `online_domestic`, `other_domestic`, `unknown`.

## Workflows

### 1. Log a price the user saw
1. You need **component, model name, price, type (asking or sold), condition, level**. Type and condition have
   **no defaults**: if the user did not say, ask. Seller and date are optional; date defaults to today in the
   market's time zone.
2. Run `pcp log`. Echo back the `id`, any flag (`sanity_flag`, `duplicate_of`), and the `group` line, for example
   "now 3 entries from 3 sellers, tier good, median PKR 46,000". If `group.needs` is set, say what is missing.
3. A flagged price (`too_low`/`too_high`) is saved but excluded from statistics. Ask whether they verified it;
   if yes run `pcp override <id>`.
4. Duplicates are flagged only when seller, model, condition, type and price match within one day. The user
   can undo with `pcp unmark-dup <id>`.

### 2. "What is the price of X?"
Run `pcp latest "<model>"` (add `--component`, `--condition`, `--level` when known). Report **the tier word with
every number**. Only a `good` tier median is "the price". `weak` or `stale` numbers are references: say
"insufficient data" and show the raw latest entry with its age. If nothing matches: "no data", never 0 and never a
number from memory.

### 3. "Is this a good price?" (never say "good deal")
Run `pcp deal`. Report, in this order: price position per level (much below, below, typical, above, much above, or
insufficient data with the reason), risk keywords with their quoted snippets, the in-person checklist for that
component, and the fixed line "These checks help but do not prove a part is genuine or healthy. Test in person
before paying." Never print a median when the tier is not good.

### 4. Compare builds
`pcp build list` shows Light / Heavy / Beast starting ideas ("starting idea, not a recommendation"). Run
`pcp build total --preset heavy --condition used`, adding `--set COMPONENT="model"` to swap a part for one the user
has logged. A headline total exists only when every part is `good`; otherwise report the `partial X/Y` label and the
known-only subtotal. Asking and sold totals are separate. Show the compatibility checklist as something **the user
ticks**; never claim a build is compatible.

### 5. Collect from the web (only when the user asks)
You do the browsing with your own tools (search, fetch, browser); the CLI never touches the network. Find sources from the
profile (`online_sources`, `search_queries`), read **public** pages only, then pipe the text in:
`pcp extract --stdin --queue --source <site> --url <url> --name "<model>" --component GPU`.
Prices must appear verbatim; each candidate keeps a quote. Nothing is in statistics until the user chooses
component, type and condition and you run `pcp candidates confirm`. Confirmed rows are stored as `reported` at
`online_domestic` so they never mix with in-person shop quotes. Foreign-currency numbers stay reference-only. Rules
and per-tool recipes: `references/collection.md`.

### 6. Aliases (merging two model groups)
`pcp alias suggest` is display-only. `pcp alias merge --alias K --into K` previews what medians would change and
does nothing until the user agrees and you add `--confirm`. When unsure, keep groups split. Reverse with
`pcp alias unmerge`.

## Hard rules

- The CLI owns every number, date, tier and position. Do not round, average, convert currency, or forecast.
- Missing is "no data". Never 0, never a guess, never a price recalled from training data or a web snippet that was
  not queued and confirmed.
- Never mix asking with sold, levels, conditions, or kits with singles in one statistic. The CLI keeps them apart;
  do not blend its numbers in prose.
- Never write the words genuine, safe, guaranteed, "will drop", "will rise" or "compatible" as a claim, and never
  call a price a "good deal", a "scam" or give a score. Verdict words are only the position labels the CLI returns.
- If the user asks for a future price: say this tool does not forecast, show the trend of their own dated data, and
  repeat any "seller said going up/down" notes as notes, not predictions.
- Collection: public pages only. Never log in, solve CAPTCHAs, scrape private groups, message sellers, buy, or post.
- Never auto-confirm candidates, auto-merge groups, or edit the event log by hand. Originals are never overwritten:
  corrections are new linked rows and voids are soft.
- User data lives under the user's data directory (`pcp doctor` shows it), outside this skill folder.
  Never delete it; back it up with `pcp backup` before risky changes.

## Reference index (read only what the task needs)

| File | Read it when |
| --- | --- |
| [references/commands.md](references/commands.md) | you need an exact flag, output field or error code |
| [references/methodology.md](references/methodology.md) | the user asks how a median, tier, trend or identity key is decided |
| [references/market-profiles.md](references/market-profiles.md) | setting up a new country, verifying a profile, or setting sanity ranges |
| [references/collection.md](references/collection.md) | gathering listings with search, fetch, browser, Firecrawl or changedetection.io |
| [references/data-model.md](references/data-model.md) | restoring data, reading the log, or understanding the export format |
| [references/web-app-bridge.md](references/web-app-bridge.md) | the user also runs the PC Market Watcher web app |
| [references/install.md](references/install.md) | installing for opencode, Claude Code, Codex, Gemini CLI or others |
| [references/troubleshooting.md](references/troubleshooting.md) | a command returned an error code |
| [assets/profiles/_template.json](assets/profiles/_template.json) | writing a profile for a country with no curated data |
| [evals/evals.json](evals/evals.json) | checking that an agent follows this skill correctly |

## Example (synthetic numbers, for illustration only)

User: "RX 6600 at Hafeez Center is 52k, a guy on OLX wants 48k, both used."
1. `pcp status --json` returns NO_COUNTRY, so ask "Which country?". The user says Pakistan, so `pcp init --country PK`.
2. Ask for anything missing (asking or sold? both asking). Log two rows: `--level local_market --seller "<shop>"` and
   `--level online_domestic --seller "OLX seller"`. They form two separate groups.
3. Reply from the output only: "Saved #1 and #2. Local market: 1 entry from 1 seller, tier weak. Online: 1 entry,
   tier weak. Needs 2 more sellers each before a median is meaningful." No verdict, no forecast.
