# Pi Quota Router

Pi Quota Router is a normal-Pi extension for several equivalent ChatGPT Codex accounts. It keeps the selected `openai-codex` model and thinking level unchanged, but chooses the account whose useful weekly quota is most urgent to spend.

It refreshes reported 5-hour and weekly usage before automatic selection, classifies provider windows by their explicit duration, reserves accounts across concurrent Pi processes, refreshes OAuth tokens under a cross-process lock, and can fail over only before model-visible output. Optional one-shot priming can start an untouched account's weekly reset clock, but only after two explicit confirmations for that request.

## Install from GitHub

This public repository is installed through Pi's Git package support. It is not yet published to npm and is not listed in the pi.dev Package Catalog. A later, separately authorized first npm publish is required before catalog discovery can occur. Install from the public HTTPS Git source:

```bash
pi install https://github.com/robinbraemer/pi-quota-router.git
```

For repeatable installs, pin the tag or exact commit you reviewed:

```bash
pi install https://github.com/robinbraemer/pi-quota-router.git@<tag-or-commit>
```

Restart Pi after installation. The extension supports normal Pi `>=0.80.6` on Node.js `>=22.19.0`. It overrides only Pi's built-in `openai-codex` provider; it does not require a Pi fork or Lavish.

Review the commit before installing, especially when using an unpinned ref: Pi extensions run with the same local authority as Pi. See [Security](docs/security.md) before adding an account.

## First use

Open normal Pi and add each Codex account with a distinct label:

```text
/quota-router login work
/quota-router login personal
/quota-router list
/quota-router status
```

Each `login` starts Pi's normal OpenAI Codex OAuth flow, then asks whether to open the validated authorization URL in the default browser, copy it, or show it for manual use. Choosing the manual action, or encountering an unavailable selector, browser, or clipboard, displays that URL for manual use. A successful browser callback can complete OAuth without waiting for an outstanding selector or manual-code prompt. After credentials are saved, the footer rerenders immediately with the account label; this display update does not count as a successful route or affect automatic-routing hysteresis. Reauthenticating an existing identity also clears its persisted authentication block, and a later failure from the replaced credential cannot invalidate the new login. The router keeps its own multi-account vault and does not rewrite Pi's `auth.json`.

After at least one account has a weekly reset timestamp, ordinary Codex prompts route automatically. The model id, capabilities, and selected thinking level are passed through unchanged.

## How automatic selection works

An account must first be healthy and usable. Automatic routing excludes accounts that need reauthentication, are blocked or reserved, lack usable quota data, are more than 24 hours stale, have less than 10% headroom in a reported 5-hour window, have less than 3% weekly headroom, or are untouched without an observed weekly clock. A provider may report only a duration-tagged weekly window; that account remains eligible and no 5-hour limit is invented.

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

Scores within 10% are treated as tied. The router retains the eligible account that last completed a routed request within that band; a login display update or failed route does not receive this preference. Otherwise it prefers the least weekly quota remaining, then the most 5-hour quota remaining when both tied accounts report that window, then the stable managed account id. See [the exact policy](docs/policy.md).

If fresh selection finds no eligible account, the foreground turn ends immediately with an actionable error. The router does not keep an old turn open waiting for quota or account health to recover; retrying later starts a new selection pass and can use any account that has recovered. Replay-safe failover among currently eligible accounts still occurs before model-visible output.

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
| `/quota-router` | Show compact status plus highlighted common commands. |
| `/quota-router help` | Show the same discoverable command guide. |
| `/quota-router status` | Show the current compact routing status. |
| `/quota-router list` | List managed ids, labels, reauthentication state, and cached quota state. |
| `/quota-router accounts` | Compatibility alias for `list`. |
| `/quota-router login [label]` | Add or reauthenticate a Codex account through Pi OAuth. |
| `/quota-router use <account-or-label>` | Force a specific account, including below automatic headroom floors. |
| `/quota-router use auto` | Return to quota-aware automatic routing. |
| `/quota-router refresh [account-or-all]` | Refresh OAuth if needed and force fresh quota usage, reconciling estimated quota cooldowns. |
| `/quota-router prime [account-or-all]` | Ask for both confirmations, send at most one minimal primer request, refresh quota, then stop. |
| `/quota-router policy` | Print the active JSON policy. |
| `/quota-router reset cooldowns` | Clear persisted quota/auth/transient cooldowns. |
| `/quota-router reset reservations` | Clear persisted request leases. Use only when no peer Pi process is active. |
| `/quota-router reset priming` | Clear observed primer results and retry times. |
| `/quota-router reset all` | Clear all non-credential runtime state. |
| `/quota-router verify` | Validate router files and report the managed account count. |
| `/quota-router path` | Print every router data path. |
| `/quota-router log [on\|off]` | Show, enable, or disable the bounded diagnostic event log for this Pi session. |

A manual account is selected without first fetching quota usage and bypasses automatic freshness, untouched-clock, and headroom checks. It is still rejected if it needs reauthentication, has an active block, or has a live account primer lease. Foreground peers do not veto the override. If labels are duplicated, select the account by its managed id from `list`. Return to `auto` when the exceptional task is finished.

## Footer legend

```text
Codex · work · 5h 72% · 7d 41%/18h · urgent 0.023/h · auto
```

- `work`: active account label.
- `5h 72%`: short-window quota remaining.
- `5h n/a`: the provider reported no five-hour limit; no short-window headroom is fabricated.
- `7d 41%/18h`: weekly quota remaining and time until reset.
- `urgent 0.023/h`: remaining weekly fraction per hour until reset.
- `auto`, `manual`, or `login`: routing mode.
- `?`: usage or reset data is not yet known.

After a restart, status restores a manual account or the most recently persisted selection when possible; cached usage supplies its quota fields without startup network work.

## Files and permissions

By default, data lives in `~/.pi/agent/pi-quota-router/`. If `PI_CODING_AGENT_DIR` is set, it lives below that directory instead.

| File | Contents | Mode |
| --- | --- | ---: |
| `accounts.json` | Raw account id, OAuth access/refresh tokens, labels, expiry | `0600` |
| `config.json` | Routing, headroom, hysteresis, and priming policy | `0600` |
| `state.json` | Non-secret cached usage, blocks, reservations, primer state, last selection | `0600` |
| `events.ndjson` | Redacted bounded operational events | `0600` |

The containing directory is `0700`. Same-directory temporary files, lock targets, and the single rotated `events.ndjson.1` predecessor are also private. Details and threat limits are in [Security](docs/security.md).

Cached usage snapshots survive Pi restarts. The router reuses them while fresh, can fall back to them conservatively for up to 24 hours after a fetch failure, and refreshes them when their freshness or recorded reset time expires.

Runtime `state.json` is version 2 and accepts/migrates version-one state. Version two permits a real weekly-only snapshot. Because state is credential-free and rebuildable, rolling back to an older extension requires recreating only `state.json`; `accounts.json` and `config.json` remain version one and must be preserved.

Version-one config files retain `maxRecoveryWaitMs` as a reserved compatibility field. It no longer affects foreground routing and must remain present only so existing strict config files and older rollback versions stay readable.

## Update and uninstall

Update an unpinned Git installation through Pi:

```bash
pi update --extensions
```

Pinned tag or commit installations stay at that revision. Re-run `pi install` with the new tag or commit to change them.

Remove the extension while retaining its account vault and state:

```bash
pi remove https://github.com/robinbraemer/pi-quota-router.git
```

Pi removes the package registration/clone; `~/.pi/agent/pi-quota-router/` remains available for a later reinstall. To permanently delete all router credentials and state, first uninstall, close every Pi process, verify the printed path with `/quota-router path`, and then run:

```bash
rm -rf "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/pi-quota-router"
```

That deletion cannot be undone.

## Develop with Bun

The repository uses Bun for dependency management, tests, and release checks:

```bash
git clone https://github.com/robinbraemer/pi-quota-router.git
cd pi-quota-router
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run pack:check
```

The source uses erasable TypeScript syntax and normal Pi public APIs. Development and release checks use Bun 1.3.7; the shipped extension does not use Bun runtime APIs.

## Support and security

For operational problems, start with `/quota-router verify` and [Troubleshooting](docs/troubleshooting.md). Anyone can report a reproducible bug or request an improvement through [GitHub issues](https://github.com/robinbraemer/pi-quota-router/issues).

For current reporting availability and vulnerability-handling guidance, see [Security reporting](SECURITY.md).
