# Troubleshooting

Errors are JSON with `code`, `message`, `hint`. Fix the cause; do not work around it.

| Code | Meaning | What to do |
| --- | --- | --- |
| `NO_COUNTRY` | No market selected | Work out the user's country (ask if unsure), then `pcp init --country XX` |
| `BAD_COUNTRY` | Not an ISO 3166-1 alpha-2 code | Use two letters (PK, IN, US). `pcp country list` |
| `UNKNOWN_COUNTRY` | No built-in facts for that code | `pcp init --country XX --currency AAA --tz Area/City` after looking those up |
| `BAD_CURRENCY` | Not an ISO 4217 code | Use a 3-letter code (PKR, USD, EUR) |
| `BAD_TIMEZONE` | Not an IANA zone | Use `Area/City`, for example `Asia/Karachi`, `Europe/London` |
| `VALIDATION` | A field is missing or invalid (`details.errors` lists each) | Ask the user for missing **type** or **condition**; fix price format; dates must be real, not in the future |
| `USAGE` | Wrong flags (exit 2) | `pcp help` or `references/commands.md` |
| `NOT_FOUND` | No such id/group/candidate | `pcp list`, `pcp groups`, `pcp candidates list` |
| `AMBIGUOUS` | A uuid prefix matches several rows | Use the numeric id or a longer prefix |
| `ALIAS_REFUSED` | Merge would self-alias, cycle, or cross components | Unmerge the opposite alias first; merge only within a component |
| `REFERENCE_ONLY` | A candidate is in a foreign currency | Keep as a reference row (`pcp log --evidence reference --currency ..`) or discard |
| `BRIDGE_MISMATCH` | Web-app bridge needs the PK/PKR market | `pcp init --country PK` |
| `BAD_FORMAT` / `BAD_PROFILE` | A file is not the expected shape | Compare with `_template.json` or an export |
| `CORRUPT_LOG` | A line in the middle of the log is invalid | Do not edit. Restore from `backups/` or an export (see `data-model.md`) |
| `BAD_CLOCK` | `PCP_NOW` is not an ISO date | Unset it or fix it |
| `INTERNAL` | Unexpected | Run `pcp doctor`; report the message |

## Symptoms
- **"No data" for a model you logged.** The query may differ in identity (`XT`, `Ti`, `K`, capacity). Check with
  `pcp key --component GPU "<logged name>" "<query>"`. A different `--level`, `--condition` or `--type` is also a different group.
- **Tier stays weak.** It needs 3 entries from 2 distinct non-empty sellers inside the window. Entries without a seller never count toward sellers.
- **A row is missing from medians.** It may be flagged (`pcp list --flagged`), a duplicate, voided, superseded by a correction,
  a bundle, or a reference row. `pcp list --voided --duplicates` shows all.
- **Dates look off by one day.** Dates are the market's local calendar date. Check `pcp status` for the time zone and
  `pcp config set timezone <Area/City>` for multi-zone countries.
- **Wrong country's data.** `pcp status` shows the active market. Pass `--country XX` explicitly when working with several.
- **`pcp doctor` says time zones fail.** The Node build lacks full ICU; install an official Node 18+ build.
