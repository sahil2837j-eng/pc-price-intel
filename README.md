# pc-price-intel

A **country-agnostic Agent Skill** for tracking and judging new and used PC-part prices.

It was extracted from the PC Market Watcher project as a standalone skill. The Next.js/PostgreSQL web app and the
unrelated collection sub-skills are **not** included here.

- Works in **opencode, Claude Code, OpenAI Codex CLI, Gemini CLI, Cursor**, and any tool that reads the open
  [Agent Skills](https://agentskills.io/specification) format.
- The agent picks the user's country once; currency, time zone, number format, markets, and online sources come from
  a country profile.
- A zero-dependency Node CLI (`pcp`) does all arithmetic. Medians, tiers, trends, and build totals are computed, never
  guessed.
- No network code. No silent scraping. Collected prices wait in a review queue until the user confirms them.
- No price predictions. No claims that a used part is genuine, safe, or compatible.

## Install

Requires **Node.js 18+**. There are no npm dependencies.

```bash
git clone https://github.com/sahil2837j-eng/pc-price-intel.git
cd pc-price-intel

node install.mjs                              # ~/.agents/skills/pc-price-intel
node install.mjs --target opencode            # ~/.config/opencode/skills/pc-price-intel
node install.mjs --target claude              # ~/.claude/skills/pc-price-intel
node install.mjs --target gemini              # ~/.gemini/skills/pc-price-intel
node install.mjs --project                    # ./.agents/skills for one project
node install.mjs --link --bin ~/.local/bin    # symlink + `pcp` on PATH
node install.mjs --dry-run                    # show what would happen
node install.mjs --uninstall                  # remove the skill; user data is untouched
```

Install to **one** skill folder. opencode reads `~/.agents/skills`, `~/.config/opencode/skills`, and
`~/.claude/skills`, so installing to several can show the same skill name more than once.

Restart the agent after installing, then verify:

```bash
pcp doctor
# or
node ~/.agents/skills/pc-price-intel/scripts/pcp.mjs doctor
```

### Release archive

Each release includes `pc-price-intel-v1.0.0.tar.gz` and `.zip` containing the `pc-price-intel/` folder. Unpack it
into your agent's skills directory if you do not want to clone the repository.

## How an agent uses it

```bash
pcp status --json
# If there is no active market, the CLI returns NO_COUNTRY.
pcp init --country PK --market "Saddar Peshawar"

pcp log --component GPU --name "Sapphire Pulse RX 6600 8GB" \
  --price 53000 --type asking --condition used \
  --level local_market --seller "shop name" --json

pcp latest "RX 6600 8GB" --condition used --json
pcp deal --component GPU --name "RX 6600" --price 48000 \
  --condition used --level local_market --text "urgent, no return" --json
pcp build total --preset heavy --condition used --json
```

The CLI is the source of truth. An agent should quote the CLI's `*_text` money fields, report the tier with every
number, and say **"insufficient data"** when the tier is not `good`.

## What it does

| It is | It is not |
| --- | --- |
| A local price log with tier, median, and "needs N more sellers" feedback | A price predictor |
| An identity normalizer (`RX6600 8GB` = `Sapphire Pulse RX 6600`) | A scraper; the CLI has no network code |
| A median / tier / trend / build-total calculator | An authenticity checker |
| A review queue for prices collected online | A seller messenger, auto-buyer, or listing poster |

Core rules:

- A group is `good` only with at least 3 rows, at least 2 distinct sellers, and at least one row in the 30-day window.
- Only a `good` median can be called a price. Weak and stale medians are display-only references.
- Asking vs sold, shop vs online, new vs used, and kits vs singles are never mixed.
- Missing means "no data", never zero.
- Corrections create linked rows; voids are soft; originals are never overwritten.
- Online collection is opt-in, public-page only, and review-queued.

## Repository layout

```text
pc-price-intel/
├── install.mjs                  one-command installer (cross-platform, no dependencies)
├── LICENSE
└── pc-price-intel/              the skill (folder name == skill name)
    ├── SKILL.md                 agent instructions and activation metadata
    ├── references/              commands, methodology, profiles, collection, data model, install, troubleshooting
    ├── scripts/pcp.mjs          the CLI + scripts/lib/*.mjs (zero dependencies, no network)
    ├── assets/
    │   ├── data/                token lists, risk terms, checklists, build presets, country table
    │   └── profiles/            PK, IN, BD, US, GB, AE, NG + a template
    ├── evals/evals.json         behaviour checks for agents
    └── tests/                   70 tests: logic, CLI, installer, spec lint, guards
```

User data lives outside the skill folder, under the user's data directory. `pcp doctor` shows the path; override it
with `PCP_DATA_DIR`. Installing, upgrading, and uninstalling never touch that data.

## Develop and test

```bash
cd pc-price-intel
npm test
# or
node --test tests/*.test.mjs
node scripts/pcp.mjs help
```

Add a country by copying `assets/profiles/_template.json` or using `pcp profile import`, and keep `verified: false`
until the sources are checked.

## License and attribution

MIT. See [LICENSE](LICENSE).

Extracted from the **PC Market Watcher** project (MIT). The web app, its database, and its UI are not part of this
repository; only the standalone skill is published here.
