# Routing policy

This document describes the behavior implemented and tested in `src/routing/selection-policy.ts`. Percentages below mean quota remaining unless explicitly called “used.”

## Automatic eligibility

Automatic routing rejects an account when any of these conditions is true:

- routing is disabled;
- OAuth is marked `needsReauth`;
- a live quota/auth/transient block exists;
- another request holds a live reservation;
- no usage snapshot is available;
- the snapshot is more than 24 hours old;
- the weekly window or its reset timestamp is unknown;
- the account is untouched and has not obtained a reset clock through confirmed priming;
- 5-hour remaining quota is below 10%;
- weekly remaining quota is below 3%.

Usage younger than five minutes is fresh. Data from five minutes through 24 hours is stale fallback data. The router uses a fresh eligible tier whenever one exists. Only when no fresh account is eligible may stale data participate, with five percentage points subtracted from both remaining windows before the headroom checks.

The headroom floors are conservative safety margins, not predicted task costs. Codex exposes quota percentages but no dependable mapping from an arbitrary future turn to percentage cost.

## Urgency and ordering

For every eligible account:

```text
weeklyRemainingFraction = clamp(1 - weeklyUsedPercent / 100, 0, 1)
hoursToReset = max((weeklyResetAt - now) / 3_600_000, 0.25)
urgency = weeklyRemainingFraction / hoursToReset
```

Higher urgency wins. It is the fraction of the weekly allowance that must be consumed per hour to avoid expiring unused. Thus an account with more remaining quota and fewer days left normally wins, instead of accounts being equalized by used percentage.

The top 10% urgency band is hysteresis/tie territory:

1. If the current account remains eligible and is within 10% of the top urgency, retain it.
2. Otherwise consider all candidates within 10% of the top urgency.
3. Prefer the least weekly quota remaining that is still above the 3% floor.
4. Then prefer the most 5-hour quota remaining.
5. Finally use lexical managed account id for deterministic selection.

Stable managed ids are truncated SHA-256 derivatives of raw Codex account ids. Raw ids never enter selection logs.

## Manual routing

`/quota-router use <account>` sets a deliberate manual override. A manual account bypasses automatic freshness, untouched-clock, and 10%/3% headroom checks. This makes the command genuinely forceful.

The manual account is still unavailable when it needs reauthentication, has an active block, or has a live reservation. The router does not silently fall back to an automatically ranked account in that case; it reports `manual_account_unavailable`. Use `/quota-router use auto` to resume automatic ranking.

## Reservations and concurrency

Selection and reservation happen inside one locked state update. A foreground lease lasts two minutes unless released earlier at stream completion/error. Expired leases are removed during later selection. Two concurrent Pi controllers sharing a profile therefore cannot acquire the same free account.

Primer work uses both a singleton sweep lease and an account lease. Foreground activity stops primer work so synthetic spend does not compete with a user request.

## Failure and recovery policy

- Pre-output `429`, quota, usage-limit, or rate-limit errors block the account and may rotate to another account.
- A transport `start` event is replay-safe.
- Any text, thinking, or tool-call start makes replay unsafe; later errors are forwarded without account rotation.
- A request performs at most five account attempts.
- An observed reset controls a quota block. Without a reliable reset, the estimate is one hour.
- All-limited recovery waits are abortable, recheck state at most once per minute, and stop after six hours.
- `invalid_grant` and revoked refresh tokens set `needsReauth` until a new login replaces the credentials.
- Generic network/timeout failures use a one-minute transient retry time.

## Priming policy

Both `priming.enabled` and `priming.confirmedFirstUseRollingWindow` must be true. The `/quota-router prime` command obtains both confirmations before setting them.

An untouched candidate must have a fresh snapshot, 0% used in both windows, and no weekly reset timestamp. The primer sends one `.` request with no history/tools, minimum reasoning, and one output token. It succeeds only if a forced post-request usage refresh reveals a weekly reset timestamp. Otherwise the account waits one hour before another primer attempt.

Background idle sweeps prime at most one account sequentially. Successfully primed accounts are recorded and enter normal urgency routing.
