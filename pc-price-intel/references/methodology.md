# Methodology (how every number is decided)

All of this is implemented in `scripts/lib/` and covered by `tests/`. Nothing here depends on the country.

## Identity key
`key = "<component lowercase>:<sorted tokens>"` built in `normalize.mjs`:
1. Unicode NFKC, lowercase, non-alphanumerics become spaces, letters and digits are split (`rx6600` becomes `rx 6600`,
   `5600x` becomes `5600 x`). Only Latin letters and digits count, so pass the Latin model name.
2. Vendor words (asus, msi, sapphire, corsair, intel, amd, ...) and sub-brand words (pulse, dual, ventus, strix, ...) are dropped.
   Never dropped: `ti xt super k x g f s m`. A bare number is never dropped.
3. A capacity pair (`8 gb`, `1 tb`) is kept, except when the base model is in `capacity_redundant`
   (models that only ever ship with one capacity, such as RX 6600), where it is dropped.
4. Tokens are sorted. Lists live in `assets/data/tokens.json` and can be extended per country with
   `pcp config set extra_vendor_words ...`.

Same: `RX6600`, `rx6600 8GB`, `Sapphire Pulse RX6600 8GB`, `Radeon RX 6600`; `i7-4770`, `i7 4770`, `Intel Core i7 4770`;
`16GB DDR3`, `DDR3 16GB`.
Different: RX580 4GB vs 8GB; GTX1060 3GB vs 6GB; RX6600 vs XT; RTX3060 vs Ti; RTX3060 8GB vs 12GB; DDR3 vs DDR4;
2x8GB vs 16GB; 1TB vs 2TB; i7-4770 vs 4770K. **When unsure the tool splits**: a wrong merge hides real price
differences, a wrong split only needs one more entry.

Aliases are user-confirmed merges resolved at query time (max 5 hops, cycle refused, reversible). Suggestions are display-only.
Seller keys normalise case and punctuation so "Al-Noor Computers" and "al noor computers" are one seller; an empty seller is never counted.

## Group
`(resolved key, item kind, condition, price type, location level)`. Asking and sold, levels, conditions, and kits vs
singles are never mixed in one statistic or total.

## Eligibility
A row feeds statistics only if it is not voided, not superseded by a correction, not a flagged duplicate, not a bundle,
its sanity flag is `ok` (or the user overrode it), it is in the market's currency, and its evidence is not `reference`.
Bundles and reference rows are stored and visible but never counted.

## Median
Integer minor units. Odd count: the middle value. Even count: the mean of the middle two, rounded half-up (100.5 becomes 101).

## Tier (inside the window, default 30 days, by the market's local calendar date)
- **good**: at least `min_samples` (3) entries AND at least `min_sellers` (2) distinct non-empty sellers AND at least one entry in the window.
- **weak**: entries in the window but the thresholds are not met. The median is display-only.
- **stale**: entries exist only outside the window. The median is an all-time reference and labelled so.
- **none**: no entries.
Only `good` medians are summed into totals or used for price position.

## Trend
`cur` = last W days, `prev` = the W days before that. Both need at least 2 entries, otherwise the result is "insufficient":
no statement, no direction. `change = cur median - prev median`, `pct = |change| / prev median`, one decimal.
Direction is `flat` when `pct < trend_flat_pct` (3.0), else `up` or `down`. The sentence is a code template.
`low_confidence` is true when either window has fewer than 6 entries ("early data is mostly noise"). Nothing predicts the future.

## Price position (only when the tier is good)
`ratio = price / median`: `much_below` at or under 0.70, `below` under 0.90, `typical` up to 1.10, `above` under 1.30,
`much_above` from 1.30. Anything else is `insufficient_data` with no median shown.

## Sanity ranges
Per component, in major units, per country: below `min` is `too_low`, above `max` is `too_high`. A flagged price is saved,
visible, and excluded until the user overrides it. No range for a component means `ok` (never an invented threshold).
Only PK ships a range; for other countries set them from real entries (see `market-profiles.md`).

## Duplicates and corrections
Duplicate: same non-empty seller key, same resolved model, same kind, condition, type and price, observed within 1 day.
Detected at insert only. A different price is a separate row. Correction: a new row with `correction_of`; the original stays,
visible, and becomes ineligible; chains work. Void: soft, with a reason, reversible.

## Time
Stored as UTC. "Today" and `observed_date` use the market's IANA time zone, so the date changes at local midnight
(Pakistan at 19:00 UTC, India at 18:30 UTC). Future dates are refused.
