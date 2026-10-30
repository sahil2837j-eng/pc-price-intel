# Collecting prices from the web

**The core CLI has no network code.** You collect text with your own tools, then hand it to `pcp extract`. That keeps
secrets, rate limits and site rules in your control, and keeps the audit trail honest.

There is also an **optional, explicit one-page collector** at `tools/collect.mjs`. It is not part of the core CLI. It
runs only when invoked, fetches at most one public page per run, and queues rows as candidates. It never confirms and
never writes statistics. It refuses source paths that robots.txt disallows and refuses CAPTCHA pages.

## Rules (non-negotiable)
- Public pages only. Never log in, solve or bypass CAPTCHAs, scrape private groups (Facebook, WhatsApp, Telegram), message
  sellers, add to cart, buy or post. If a source needs a login, ask the user to paste the text.
- Only when the user asked for online collection. One page at a time; no loops, no scheduled crawling from this skill.
- Respect robots.txt and the site's terms. Identify yourself honestly if your tool lets you. Back off on 429.
- Never trust a snippet you did not read in full. The price must appear verbatim in the text you extract from.
- Collected prices are **candidates**. They enter statistics only after the user decides component, type and condition.

## Optional one-page collector

```bash
# OLX public search: local used/asking rows; seller is not on the search card
node <skill folder>/tools/collect.mjs olx --query "rx 6600" --component GPU \
  --require "rx\\s*6600" --exclude "xt|bundle|full pc|mobo" --max 10 --queue

# Amazon public search: reference-only by default
node <skill folder>/tools/collect.mjs amazon --query "rx 6600" --component GPU \
  --require "rx\\s*6600" --exclude "xt" --max 10 --queue

# Daraz: manual saved JSON only (robots.txt disallows /catalog/)
node <skill folder>/tools/collect.mjs daraz --file daraz-search.json --component GPU --require "rx\\s*6600"

# Alibaba: a specific product-detail page only (search is blocked by robots/CAPTCHA)
node <skill folder>/tools/collect.mjs alibaba --url "https://www.alibaba.com/product-detail/..." --component GPU
```

| Source | Network path | Meaning |
| --- | --- | --- |
| OLX Pakistan | `/items/q-...` search page (robots allows) | Used/asking local listings; not sold prices |
| Amazon.com | `/s?k=...` search page (robots allows) | Retail/import **reference**; excluded from statistics |
| Daraz Pakistan | None: `/catalog/` is disallowed by robots.txt | Manual saved JSON/page only |
| Alibaba | `/product-detail/` only; `/trade/` search is disallowed and CAPTCHA-protected | Wholesale/MOQ **reference**; not a local retail or used price |

The collector never confirms. It prints the rows and, with `--queue`, sends them to `pcp candidates add`. A human then
chooses component, type, condition, and (where known) seller. For OLX/Amazon search cards the seller is absent by design;
open the listing URL and pass `--seller` at confirm time if distinct-seller tiering matters.

## Pipeline
1. **Pick sources** from the profile (`online_sources`, `search_queries`). Fill `{model}`, `{country}`, `{market}`, `{currency}`.
2. **Read the page** with the best tool available:
   - plain page: your fetch/web-read tool (markdown is ideal);
   - dynamic page (price appears after a click or variant choice): Playwright MCP or Browser Use (navigate, snapshot,
     click the variant, snapshot again, copy the visible text);
   - structured extraction at scale: Firecrawl scrape (markdown or JSON mode) if the user has an API key.
3. **Queue it**:
   ```
   printf '%s' "<page text>" | pcp extract --stdin --queue --source "<site>" --url "<page url>" \
       --name "<model as listed>" --component GPU --json
   ```
   Output lists every price found with its verbatim `quote`. No price found means "price not found"; do not invent one.
   Use `--pattern "Price:\s*Rs\.?\s*([\d,]+)"` (one capture group) when a page has many numbers.
4. **Show the user** `pcp candidates list`: model, price, quote, source. Ask only for what the page did not state:
   component, asking or sold, condition.
5. **Confirm** each row the user accepts:
   `pcp candidates confirm <id> --component GPU --type asking --condition used` (optionally `--level other_domestic --date YYYY-MM-DD`).
   Discard the rest. Never confirm on the user's behalf without their yes.

Structured rows (from a scraper or your own parsing) go in with `pcp candidates add --file rows.json`:
`[{"name":"...","price":"53,000","component":"GPU","condition":"used","quote":"...","url":"...","seller":"Shop A","location":"Lahore","evidence":"reported","level":"online_domestic"}]`.
Use `"evidence":"reference"` for a foreign-currency, Amazon, or Alibaba benchmark row; reference rows never enter statistics.
A foreign-currency candidate requires `pcp candidates confirm <id> ... --evidence reference`.

## Mapping page words to fields
| Page says | Set | Leave for the user |
| --- | --- | --- |
| "Used", "pulled out", "second hand", "open box" | `condition used` | component if unclear, asking vs sold |
| "Brand new", "sealed" | `condition new` | asking vs sold |
| "Sold", "sold out" with a price | nothing | a list price on a sold-out page is still an asking price; ask |
| Price per kit ("2x8GB") | keep `2x8gb` in the name so kits stay separate | |
| Bundle / "full PC" | `--kind bundle` when logging | bundles never enter statistics |

## Foreign benchmarks (reference only)
A sold-price median from another market (for example completed marketplace listings in USD or EUR) can be kept as context:
`pcp log --evidence reference --currency EUR --type sold --condition used --component GPU --name "<model>" --price 178 --level unknown --source <url>`.
It is stored but never counted. Do not convert it to the local currency or present it as the local price.

## changedetection.io (automatic change alerts)
changedetection.io watches pages and keeps snapshots; it does not understand PC parts. Use it as a trigger, then read the
newest snapshot text (through its API or datastore; check its documentation for your version, do not guess endpoints) and
pipe that text into `pcp extract --stdin --queue --source changedetection`. If the user runs the PC Market Watcher web app, its
`/api/candidates` webhook accepts changedetection notifications directly (see `web-app-bridge.md`).

## What good output looks like
"Queued 2 candidates from redtech.pk: Rs. 53,000 (quote: 'Asus Dual RX 6600 8GB ... Used ... Rs. 53,000'). Nothing is in
your statistics yet. Tell me component, asking or sold, and condition for each, or discard." No medians, no verdicts.
