# Pi Quota Router

Pi Quota Router is a normal-Pi extension for several equivalent ChatGPT Codex accounts. It keeps the selected `openai-codex` model and thinking level unchanged, but chooses the account whose useful weekly quota is most urgent to spend.

It refreshes 5-hour and weekly usage before selection, reserves accounts across concurrent Pi processes, refreshes OAuth tokens under a cross-process lock, and can fail over only before model-visible output. Optional one-shot priming can start an untouched account's weekly reset clock, but only after two explicit confirmations for that invocation.

## Install from GitHub

This package is installed through Pi's Git/GitHub package support. It is not distributed through npm.

For this private repository, SSH is the most reliable install method:

```bash
pi install git:git@github.com:robinbraemer/pi-quota-router
```

If your Git credential helper already authenticates private GitHub HTTPS clones:

```bash
pi install git:github.com/robinbraemer/pi-quota-router
```

Pi supports pinned Git refs as well:

```bash
pi install git:git@github.com:robinbraemer/pi-quota-router@<tag-or-commit>
```

Restart Pi after installation. The extension targets normal Pi and overrides only the built-in `openai-codex` provider. It does not require a Pi fork or Lavish.

## First use

Open normal Pi and add each Codex account with a distinct label:

```text
/quota-router login work
/quota-router login personal
/quota-router accounts
/quota-router status
```

Each `login` opens Pi's normal OpenAI Codex OAuth flow. The router keeps its own multi-account vault and does not rewrite Pi's `auth.json`.

When the authorization URL is ready, Pi shows an explicit action selector: open it in the default browser, copy it to the clipboard, or continue manually. The full URL always remains visible, including when a browser, clipboard, or interactive selector is unavailable, and the selector does not block OAuth completion. After credentials are saved, the footer rerenders immediately with the account label; it does not wait for a later agent turn. This display update does not count as a successful route or affect automatic-routing hysteresis. Reauthenticating an existing identity also clears its persisted authentication block, and a later failure from the replaced credential cannot invalidate the new login.

After at least one account has a weekly reset timestamp, ordinary Codex prompts route automatically. The model id, capabilities, and selected thinking level are passed through unchanged.

## How automatic selection works

An account must first be healthy and usable. Automatic routing excludes accounts that need reauthentication, are blocked or reserved, lack usable quota data, are more than 24 hours stale, have less than 10% 5-hour headroom, have less than 3% weekly headroom, or are untouched without an observed weekly clock.

For each eligible account:

```text
weeklyRemaining = 1 - weeklyUsedPercent / 100
hoursToReset = max((weeklyResetAt - now) in hours, 0.25)
urgency = weeklyRemaining / hoursToReset
```

The highest urgency wins. For example:

| Account | Weekly remaining | Reset in | Urgency |
| --- | ---: | ---: | ---: |
| work | 60% | 24 hours | 0.025/hour |
| personal | 20% | 72 hours | 0.0028/hour |

`work` is selected because much more useful quota will expire per hour. This intentionally drains expiring quota instead of equalizing percentages. Equalizing can preserve a neat balance while allowing a large near-reset allowance to disappear unused.

Scores within 10% are treated as tied. The router retains the eligible account that last completed a routed request within that band; a login display update or failed route does not receive this preference. Otherwise it prefers the least weekly quota remaining, then the most 5-hour quota remaining, then the stable managed account id. See [the exact policy](docs/policy.md).

## Priming untouched accounts

Priming deliberately sends a real minimal Codex request. It is not a read-only quota check. Do not run it unless you have independently confirmed that first use starts the weekly rolling window for these accounts.

Run:

```text
/quota-router prime all
```

Pi asks for two separate confirmations:

1. Confirm that a minimal request may spend quota.
2. Confirm that first-use rolling-window behavior is known.

After both confirmations, the router sends exactly one `.` request with no history, no tools, the selected Codex model, the lowest reasoning level, and `maxTokens: 1`. After every non-aborted provider attempt, including one that reports an error, it force-refreshes usage and records any observed weekly reset timestamp. A provider error still reports `failed` even if that observation confirms the account. If no reset timestamp appears, a failed or inconclusive attempt waits one hour before another explicit retry. If the selected model is not a registered Codex model, the command stops before any usage or provider request and does not start the retry cooldown.

The confirmations authorize only the current command. They do not change `config.json`, enable idle sweeps, or authorize future background priming. `/quota-router prime all` scans for the first eligible untouched account but still sends at most one provider request; run the command again and reconfirm to prime another account. Persistent automatic priming remains disabled unless a separate explicit action is introduced and confirmed. Once a clock is observed, the account enters normal urgency routing.

## Commands

| Command | Purpose |
| --- | --- |
| `/quota-router` | Show current status plus the highlighted quick-command guide. |
| `/quota-router help` | Show the same discoverable command guide. |
| `/quota-router status` | Show the current compact routing status. |
| `/quota-router list` | List managed ids, labels, and reauthentication state. |
| `/quota-router accounts` | List managed ids, labels, and reauthentication state. |
| `/quota-router login [label]` | Add or reauthenticate a Codex account through Pi OAuth. |
| `/quota-router use <account-or-label>` | Force a specific account, including below automatic headroom floors. |
| `/quota-router use auto` | Return to quota-aware automatic routing. |
| `/quota-router refresh [account-or-all]` | Refresh OAuth if needed and force fresh quota usage, reconciling estimated cooldowns. |
| `/quota-router prime [account-or-all]` | Ask for both confirmations, send at most one minimal primer request, refresh quota, then stop. |
| `/quota-router policy` | Print the active JSON policy. |
| `/quota-router reset cooldowns` | Clear persisted quota/auth cooldowns. |
| `/quota-router reset reservations` | Clear persisted request leases. Use only when no peer Pi process is active. |
| `/quota-router reset priming` | Clear observed primer results and retry times. |
| `/quota-router reset all` | Clear all non-credential runtime state. |
| `/quota-router verify` | Validate router files and report the managed account count. |
| `/quota-router path` | Print every router data path. |
| `/quota-router log [on\|off]` | Show, enable, or disable the bounded diagnostic event log. |

A manual account is selected without a preliminary usage fetch and bypasses automatic freshness, untouched-clock, and headroom ranking. It is still rejected if it needs reauthentication or has an active block/reservation. Return to `auto` when the exceptional task is finished.

## Footer legend

```text
Codex · work · 5h 72% · 7d 41%/18h · urgent 0.023/h · auto
```

- `work`: active account label.
- `5h 72%`: short-window quota remaining.
- `7d 41%/18h`: weekly quota remaining and time until reset.
- `urgent 0.023/h`: remaining weekly fraction per hour until reset.
- `auto`, `manual`, or `login`: routing mode.
- `?`: usage or reset data is not yet known.

## Files and permissions

By default, data lives in `~/.pi/agent/pi-quota-router/`. If `PI_CODING_AGENT_DIR` is set, it lives below that directory instead.

| File | Contents | Mode |
| --- | --- | ---: |
| `accounts.json` | Raw account id, OAuth access/refresh tokens, labels, expiry | `0600` |
| `config.json` | Routing, headroom, hysteresis, and priming policy | `0600` |
| `state.json` | Non-secret blocks, reservations, primer state, last selection | `0600` |
| `events.ndjson` | Redacted bounded operational events | `0600` |

The containing directory is `0700`. Same-directory temporary files, lock targets, and the single rotated `events.ndjson.1` predecessor are also private. Details and threat limits are in [Security](docs/security.md).

## Update and uninstall

Update the GitHub-installed package through Pi:

```bash
pi update --extensions
```

Remove the extension while retaining its account vault and state:

```bash
pi remove git:git@github.com:robinbraemer/pi-quota-router
```

Pi removes the package registration/clone; `~/.pi/agent/pi-quota-router/` remains available for a later reinstall. To permanently delete all router credentials and state, first uninstall, close every Pi process, verify the printed path with `/quota-router path`, and then run:

```bash
rm -rf "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/pi-quota-router"
```

That deletion cannot be undone.

## Develop with Bun

The repository uses Bun for dependency management, tests, and release checks:

```bash
git clone git@github.com:robinbraemer/pi-quota-router.git
cd pi-quota-router
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run pack:check
```

The source uses erasable TypeScript syntax and normal Pi public APIs. Development uses Bun 1.3.7+, while the shipped extension remains compatible with normal Pi's Node.js runtime (`>=22.19.0`) and does not use Bun runtime APIs.

For problems, start with `/quota-router verify` and [Troubleshooting](docs/troubleshooting.md).

## Design provenance

The clean-room implementation combines the best ideas from `victor-software-house/pi-multicodex` (stream boundary and modularity), `Sarrius/pi-multi-account` (cooldowns, invalidation, logs, recovery), and `kim0/pi-multicodex` (untouched-account priming), with a quota-urgency policy and stronger atomic storage/concurrency guarantees. See the [design specification](docs/superpowers/specs/2026-07-10-pi-quota-router-design.md).
