# Installing the skill

Requirements: Node.js 18+ (no npm install). The skill folder is `pc-price-intel/` (contains `SKILL.md`).

## Where each agent looks
| Agent | Global folder | Project folder |
| --- | --- | --- |
| opencode | `~/.config/opencode/skills/`, also reads `~/.claude/skills/` and `~/.agents/skills/` | `.opencode/skills/`, `.claude/skills/`, `.agents/skills/` |
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| OpenAI Codex CLI | `~/.agents/skills/` | `.agents/skills/` |
| Gemini CLI | `~/.gemini/skills/` and `~/.agents/skills/` | `.gemini/skills/`, `.agents/skills/` |
| Cursor, Copilot, others | their documented skills folder | see their docs |

The format is the open Agent Skills standard, so the same folder works everywhere. opencode asks that skill names be
unique across locations, so install to **one** place. `~/.agents/skills/` covers opencode, Codex and Gemini CLI; add
`~/.claude/skills/` only if you use Claude Code (or pick `--target claude` for a Claude-only setup).

## One command
From the repository root:
```
node install.mjs                      # ~/.agents/skills/pc-price-intel
node install.mjs --target opencode    # ~/.config/opencode/skills/pc-price-intel
node install.mjs --target claude      # ~/.claude/skills/pc-price-intel
node install.mjs --project            # ./.agents/skills (current project only)
node install.mjs --link               # symlink, so repo edits go live
node install.mjs --bin ~/.local/bin   # also puts a `pcp` launcher on PATH
node install.mjs --dry-run            # show what would happen
node install.mjs --uninstall          # remove (data is never touched)
```
Then restart the agent (or begin a new session) so it re-scans skills, and verify:
`node ~/.agents/skills/pc-price-intel/scripts/pcp.mjs doctor`.

## Manual
```
cp -r pc-price-intel ~/.agents/skills/            # macOS / Linux
Copy-Item -Recurse pc-price-intel $HOME\.agents\skills\   # Windows PowerShell
```
Or download the release archive (`pc-price-intel-v1.0.0.tar.gz`) and unpack it into the skills folder.

## Permissions (opencode)
To require approval before the skill loads, in `opencode.json`:
`{"permission":{"skill":{"pc-price-intel":"ask"}}}`. The CLI itself only reads and writes the data directory.

## Upgrading and uninstalling
Re-run the installer: it replaces the skill folder (it refuses to overwrite a folder that is not this skill unless `--force`).
Price data lives in the data directory (`pcp doctor` shows it; override with `PCP_DATA_DIR`) and is untouched.
Back it up with `pcp backup` or `pcp export`.

## Using it without an agent
It is a normal CLI: `node scripts/pcp.mjs help`. With `--bin` you get `pcp` on PATH.
