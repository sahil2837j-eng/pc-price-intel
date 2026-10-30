# Bridge to the PC Market Watcher web app

The separate PC Market Watcher project also contains a Next.js + PostgreSQL app (first built for Saddar,
Peshawar, in PKR). That web app is **not included in this repository**. The skill works completely without it. If the
user runs both, move data with JSON files.

## File bridge (no server needed)
| Direction | Command |
| --- | --- |
| Web app to this tool | In the app: Settings, Data & Backup, export. Then `pcp init --country PK` and `pcp import app-export.json --from-app` (dry run), then add `--confirm` |
| This tool to the web app | `pcp export --as-app --out for-app.json`, then import in the app's Settings (dry run first) |

Notes: PKR (0 decimals) only. Level names map `local_market` to `peshawar_shop`, `online_domestic` to `pakistan_online`,
`other_domestic` to `pakistan_other`. Reference (foreign currency) rows are skipped on export and counted in
`skipped_reference_rows`. Aliases are not carried (model keys differ between normaliser versions): re-create with
`pcp alias merge`. UUIDs are preserved, so repeated imports are idempotent.

## Live API (when the app is running at `http://127.0.0.1:3000`)
Same concepts, over HTTP. The app's own `SKILL.md` at the repository root documents every route. Most useful:

```
GET  /api/health                         liveness
POST /api/observations                   log a price (price_pkr, priceType and condition required)
GET  /api/groups                         tiers, medians, needs
POST /api/deal-check                     position, risk hits, checklist
POST /api/candidates                     webhook / ingest into its review queue
POST /api/candidates/{id}                {"action":"confirm", component, priceType, condition} or {"action":"discard"}
```
Web collection inside the app is opt-in (Settings, Online) and, like here, review-queued. The web app is Pakistan/PKR-first;
for any other country use this skill's CLI.
