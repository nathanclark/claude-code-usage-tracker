# Claude Code usage tracker

A Claude Code plugin that logs how you actually use Claude Code, then reports on it — which skills and agents you use or ignore, what you keep asking for, where things go wrong, which projects consume the most, and which rules files are loading.

> **Read this before installing.** This plugin **records the full text of every prompt you submit** to a plain-text file on your own disk (`~/.claude/usage-log/YYYY-MM-DD.jsonl`). That is the point: you cannot cluster "what do I keep asking for" out of prompt lengths. Nothing is ever sent anywhere — the tracker makes **no network calls of any kind**, has no telemetry and no update check — but anything you type into Claude Code, secrets included, ends up in that file. If that is not what you want, set `capture_prompt_text` to `false` (see [Configuration](#configuration)) and you still get every other section of the report.

Tracks Claude Code only — the CLI, the desktop app and the IDE extensions. It cannot see claude.ai web chats.

## What you get

One command, `/usage-tracker:report`, answers five questions from your own logs:

1. **Skills, slash commands and subagents** — what fired, how often, in which projects, and what is installed but has never fired.
2. **Repeated prompts** — mechanical clusters plus the full prompt text, so Claude can group them by theme and tell you which ones should be a skill.
3. **Friction** — tool failures by signature, permission prompts and denials, interrupts, immediate retries, correction-style prompts ("no", "actually", "undo"), API failures, compactions, overlong sessions.
4. **Volume by project** — sessions, turns, tool calls, hours and token usage per repository, priced per model.
5. **Rules in effect** — which `CLAUDE.md` and instruction files loaded, with content hashes so you can see when they changed.

## Install

Requires Node 18 or later (Claude Code itself runs on Node, so you almost certainly have it) and Claude Code with plugin support.

```bash
claude plugin marketplace add <owner>/claude-code-usage-tracker
claude plugin install usage-tracker@claude-code-usage-tracker
```

Or from a clone, which is also how to develop it:

```bash
claude --plugin-dir /path/to/claude-code-usage-tracker
```

Logging starts at your next session. Nothing else to configure.

## Privacy

- **Local only.** No network calls, no telemetry, no update check, no "share your report". The one file that reaches the network is `scripts/update-prices.js`, a maintainer tool that is never invoked by the hooks, the report or the scheduled run.
- **Never inside a repository.** Logs and reports live under `~/.claude/usage-log/`, never in your project.
- **Prompt text is stored in full** unless you turn it off. See the warning at the top.
- **Tool inputs are summarised, not dumped.** A `Bash` command and a `Grep` pattern are kept because the text is the point; file contents and edit bodies are not. Any tool the logger does not recognise, **including every MCP tool**, contributes its input *key names* only — never the values. The test suite asserts this.
- **Environment variables are never logged.** The weekly run records whether an auth variable is present and how long it is, never its value, and classifies a credential by prefix alone.

## What is logged

One JSON line per event, in `~/.claude/usage-log/YYYY-MM-DD.jsonl`. Every line carries a local-time timestamp, the event name, session id, cwd, project, repository root and git branch.

| Event | What it adds |
|---|---|
| `SessionStart` | start reason (`startup`/`resume`/`fork`/`clear`), model, context tokens |
| `UserPromptSubmit` | the prompt text, its length and word count, correction markers |
| `UserPromptExpansion` | slash command name, arguments, source |
| `PostToolUse` | tool name, duration, a summary of the input |
| `PostToolUseFailure` | the error, whether it was an interrupt |
| `PermissionRequest` / `PermissionDenied` | tool, input summary, denial reason |
| `SubagentStart` / `SubagentStop` | subagent type, duration, reply size |
| `InstructionsLoaded` | file path, memory type, size, mtime, SHA-256 of the content |
| `Notification` | type, title, message |
| `PreCompact` | manual or automatic |
| `Stop` | turn number, reply size, **token usage for the turn, per model** |
| `StopFailure` | the API error that ended the turn (rate limit, overload, auth…) |
| `SessionEnd` | end reason, duration, session token totals |

### Where token counts come from

Hooks are not given token counts, so they come from the session transcript: every assistant line carries `message.usage`. Each `Stop` reads **only the bytes appended since the previous turn**, remembers a byte offset per session, and de-duplicates by API message id — so a turn is never counted twice and a long session costs no more to scan than a short one. A resumed, forked or compacted session baselines its offset at end-of-file, because the transcript it inherits was already counted.

The 1-hour and 5-minute cache writes are recorded separately, because a 1-hour cache write costs 2× input against 1.25× for a 5-minute one. A turn that spans models is split and each share priced at its own rate.

## The report

Inside a session:

```
/usage-tracker:report           # last 30 days
/usage-tracker:report 7         # last 7 days
/usage-tracker:report --from 2026-09-01 --to 2026-09-30
```

That runs the generator, then does the part a script cannot: clusters the prompts by theme, groups the friction by root cause, judges the never-fired skills, and appends a Recommendations section with a count or a quote behind every claim.

The generator on its own, with no Claude involved and no tokens spent:

```bash
node lib/report.js --days 30
```

| Flag | Meaning |
|---|---|
| `--days N` | window ending today (default 30); a bare number works too |
| `--from` / `--to` | explicit `YYYY-MM-DD` range |
| `--out-dir DIR` | where to write (default `~/.claude/usage-log/reports`) |
| `--top-prompts N` | prompts in the dump (default 150) |
| `--max-rows N` | rows before a table defers to the full dump (default 30) |
| `--json` | also emit the aggregates as JSON |
| `--quiet` | print nothing |

It writes four files: the markdown report, plus `prompts-*.txt`, `friction-*.txt` and `inventory-*.txt`, which exist so the themed pass has raw material to read without the report itself becoming unreadable.

### The money column is not always a bill

The report prices tokens at provider list price, from `lib/prices.json`. Whether that is money you are actually spending depends on how you authenticate, so the column is labelled accordingly:

| Detected | Column | Meaning |
|---|---|---|
| `subscription` | List-price equiv. | Tokens are not billed per token. A way to rank projects by weight. |
| `metered` | Est. cost | An API key, Bedrock, Vertex or a third-party gateway: an actual estimate. |
| `unknown` | List-price equiv. | Could not tell, so it does not claim to be a bill. |

Detection reads `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, and the *prefix* of `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` — never the value. Note that Claude Code passes a subscription OAuth token to child processes in `ANTHROPIC_AUTH_TOKEN` too, so presence alone proves nothing. Override it with `billing_mode` in `config.json` if the guess is wrong.

To refresh the rates (maintainers; this is the one thing that uses the network):

```bash
node scripts/update-prices.js --show-table
```

## The scheduled weekly report

Entirely opt-in — nothing is scheduled by installing the plugin.

A marketplace install lives in a versioned cache directory, so first find it (from a clone, just use the clone and skip this):

```bash
# prints the installed plugin directory
node -e "const fs=require('fs'),os=require('os'),p=require('path');const j=JSON.parse(fs.readFileSync(p.join(process.env.CLAUDE_CONFIG_DIR||p.join(os.homedir(),'.claude'),'plugins','installed_plugins.json'),'utf8'));for(const k of Object.keys(j.plugins||{}))if(k.startsWith('usage-tracker@'))for(const e of [].concat(j.plugins[k]))console.log(e.installPath)"
```

Then, with `$PLUGIN` set to that path:

```bash
node "$PLUGIN/scripts/schedule.js" --install                 # Mondays at 08:00, last 7 days
node "$PLUGIN/scripts/schedule.js" --install --day Friday --time 17:30 --days 7
node "$PLUGIN/scripts/schedule.js" --status
node "$PLUGIN/scripts/schedule.js" --run-now
node "$PLUGIN/scripts/schedule.js" --uninstall
```

Install it from the *installed* directory rather than a clone, so the launcher records the installed path and re-resolves it after an update. You only do this once: the scheduled job survives plugin updates on its own.

| Platform | Mechanism |
|---|---|
| Windows | Task Scheduler via `schtasks` (`/IT`, so it runs with your environment) |
| macOS | a launchd user agent in `~/Library/LaunchAgents` |
| Linux | a systemd **user** timer, falling back to `crontab` |

The run has two stages:

1. **The report.** Pure local computation. This is what makes the report exist.
2. **The themed recommendations.** Calls `claude -p` headless, hands it the prompt and friction dumps on stdin, and splices the markdown it returns into the report.

Stage 2 is strictly additive, and it is the fragile half: headless authentication fails in ways an interactive session never shows you. If it fails, times out or finds no CLI, **stage 1's report still stands**, the reason is written to `reports/weekly-run.log`, and the exit code is still 0 so your scheduler never reports a failed task for a report that was in fact produced. The newest report is always copied to `reports/latest-weekly.md`, so there is one stable path to open.

Three design points worth knowing, each of which was a bug first:

- **Claude reads and writes no files in stage 2.** The reports live under `~/.claude`, which Claude Code treats as a sensitive path needing approval, and a headless run has nobody to approve it. The material goes in on stdin and markdown comes back on stdout; the wrapper owns the file.
- **Success is "did usable markdown come back", not the exit code.** Useful output and a non-zero status can arrive together.
- **The scheduled job never points into the plugin directory.** A marketplace install puts each version in its own cache directory, so that path dies at the next update. The job runs a small launcher under the log directory that re-resolves the installed plugin every time it fires.

Notes: on Linux a systemd *user* timer only fires while you are logged in unless you enable lingering (`loginctl enable-linger $USER`). On Windows, `schtasks` stores a naive local start time, so 08:00 stays 08:00 across a daylight-saving change.

## Configuration

Optional, at `~/.claude/usage-log/config.json`:

```json
{
  "capture_prompt_text": true,
  "billing_mode": "auto",
  "max_scan_bytes": 67108864
}
```

| Key | Default | Meaning |
|---|---|---|
| `capture_prompt_text` | `true` | `false` logs prompt length, word count and correction markers, but not the text |
| `billing_mode` | `"auto"` | `"subscription"`, `"metered"`, or `"auto"` to detect |
| `max_scan_bytes` | 64 MiB | ceiling on one incremental transcript scan |

Environment variables win over the file: `CC_USAGE_LOG_DIR` (move the whole log directory), `CC_USAGE_CAPTURE_PROMPTS=0`, `CC_USAGE_BILLING_MODE`.

## Performance

Every hook is registered with `"async": true`, so Claude Code starts the logger and carries on without waiting. The logger writes nothing to stdout, so Claude never sees it, and always exits 0 — a failure cannot change Claude's behaviour. Anything that goes wrong is appended to `usage-log/hook-errors.log`, which should stay empty.

`SessionEnd` is also async, and deliberately does very little. SessionEnd hooks share a 1.5-second budget, and **a timeout set on a plugin's own hook does not raise that budget**, so the closing scan is capped at 8 MiB. Nothing is lost if it is cut short: `Stop` already wrote cumulative totals for every turn, and that is what the report sums.

Concurrent sessions appending to the same daily file take a short advisory lock around the append, and fall through to appending anyway rather than ever dropping an event. The test suite fires eight concurrent 20 KB writes and asserts that eight intact lines arrive.

## Check that it works

```bash
node scripts/test-hooks.js            # 32 checks, no network, nothing real touched
```

The harness builds a throwaway log directory and a synthetic transcript with known token numbers, fires one payload per registered event in realistic lifecycle order, and asserts the contract: every event captured, every hook exit 0, nothing on stdout, the error log empty, exact token totals with the duplicate message id counted once, the per-model and 1h/5m cache split preserved, the rules file hashed, MCP values never logged, the privacy switch respected, concurrent writes intact, and the full report generated with its price matching the pricing module. CI runs it on Windows, macOS and Linux against Node 18 and 22.

On your real install:

```bash
# today's events by type
node -e "const fs=require('fs'),os=require('os'),p=require('path');const f=p.join(os.homedir(),'.claude','usage-log',new Date().toISOString().slice(0,10)+'.jsonl');const c={};for(const l of fs.readFileSync(f,'utf8').split('\n'))if(l.trim())c[JSON.parse(l).event]=(c[JSON.parse(l).event]||0)+1;console.log(c)"
```

If nothing is logged: confirm the plugin is enabled (`claude plugin list`), that `node` is on the `PATH` Claude Code uses, and check `usage-log/hook-errors.log`. Start a *new* session — hooks register at session start. `claude plugin validate .` checks the manifest if you are working from a clone.

## Uninstall

```bash
node scripts/schedule.js --uninstall          # if you scheduled it
claude plugin uninstall usage-tracker@claude-code-usage-tracker
```

Neither touches your logs. Delete `~/.claude/usage-log/` yourself when you want them gone — that directory is the only thing the plugin leaves behind.

## Known limits

- Claude Code only. claude.ai and Cowork sessions are invisible to it.
- Token counts depend on the transcript carrying `message.usage`. A session whose transcript is rewritten in an unusual way may under-count; it will never double-count.
- The "never fired" inventory is only as good as the window. Give it a week of real work before trusting it, and remember it reflects what was installed *when the report ran*.
- Correction detection is English-only and keyword-based. It is a signal to read, not a verdict.
- Skill and agent names are matched between the logs and the inventory by their trailing segment, so two differently-scoped components with the same leaf name can be conflated.

## Migrating from the PowerShell version

This started as a Windows/PowerShell implementation. The JSONL schema is unchanged, so the new reporter reads logs the old one wrote (including the places where PowerShell serialised a single-element array as a scalar). Remove the old hooks from `~/.claude/settings.json` before installing the plugin, or both will log and every event will be recorded twice.

## Development

```bash
npm test                              # the harness
node lib/report.js --days 7           # the generator
node scripts/update-prices.js         # refresh bundled rates (network)
claude plugin validate .              # manifest and marketplace entry
```

Before publishing a fork, set `owner.name` and `owner.url` in `.claude-plugin/marketplace.json` to your own.

MIT licensed.
