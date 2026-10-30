# Market profiles

A profile holds everything that differs between countries. The tool needs only **country, currency, time zone**;
the rest improves extraction and tells you where to look.

## What ships
- `assets/data/countries.json`: ISO code, name, currency, primary time zone for about 50 countries. Currency decimals
  are derived from the platform (`Intl`), so 0, 2 and 3 decimal currencies all work.
- `assets/profiles/<CC>.json`: curated starting profiles for PK, IN, BD, US, GB, AE, NG (markets, online sources, local
  vocabulary, notes). All have `verified: false`.
- Any other ISO country: pass `--currency` and `--tz` to `pcp init`. A generated profile is created.
- Your own profile: `<data dir>/profiles/<CC>.json` overrides bundled facts and survives skill upgrades.

## Treat bundled facts as hints
Shop names, domains and notes were compiled from public pages and can be wrong or out of date. Before relying on them:
1. Search for the sources named in `online_sources` and confirm the site exists and still lists the part category.
2. Confirm the in-person `markets` with the user ("Do you mean X market in Y?").
3. Never copy a price from a page into a profile. Prices only enter through `pcp log`, `pcp extract --queue` and
   `pcp candidates confirm`.
4. Cite where each new fact came from (URL and date) in the final message.

## Building a profile for a new country
1. Ask or infer the country; run `pcp country list --json`. If missing, `pcp init --country XX --currency AAA --tz Area/City`.
2. Research live (your search tool). Useful queries use `search_queries` from the profile, or:
   `used {model} price {country}`, `{model} price {currency}`, `{city} computer market used graphics card`,
   `{country} used PC parts classifieds`. Prefer local-language terms the seller would write, kept in `local_terms`.
3. Find: in-person markets/bazaars (kind `in_person_market`), classifieds (`classifieds`), retailers (`retailer`), sold-price
   sources (`price_type: "sold"`, e.g. completed marketplace listings), aggregators/trackers, forums.
4. Note taxes and customs that change how to read a price (VAT or GST included in retail but not private sales, import
   duty, grey-market vs official warranty). Put them in `notes`, with a source.
5. Determine the price markers sellers actually write (`Rs.`, `₹`, `$`, `Tk`, `₦`, `/-`) and the number format
   (`thousands`, `decimal`, `grouping`: `standard` = 1,000 groups, `flexible` = also 1,00,000 style).
6. Save: copy `assets/profiles/_template.json`, fill it, then `pcp profile import <file>`. Set `verified: true` only after
   you checked the sources; set `reviewed` to `YYYY-MM`.
7. Test extraction: `pcp extract --text "<a real sample sentence>"` must find the price verbatim.

## Sanity ranges (optional, per component)
A sanity range flags typos such as 1 or 99999999; it is never a claim about the right price. Without ranges nothing is flagged.
Set them wide after you have a handful of real entries:
`pcp config sanity GPU <min> <max>`: roughly a third of the lowest plausible price and three times the highest plausible
price the user has seen. Tell the user the numbers you chose and why.

## Levels
`local_market`: prices the user got in person or by phone/message at their home market. `online_domestic`: web listings in
the same country. `other_domestic`: another city or channel. Labels per country are in `level_labels`. Web-collected
rows default to `online_domestic` so they never inflate or deflate the in-person group.

## Multiple countries
Each country has its own event log and settings under the data directory. Use `--country XX` per command. Never compare or
sum medians across currencies; reference rows in a foreign currency are the only cross-border data and are never counted.
