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

`/quota-router use <account>` sets a deliberate manual override. The router does not fetch usage before selecting that account, and the account bypasses automatic freshness, untouched-clock, and 10%/3% headroom checks. This makes the command genuinely forceful.

The manual account is still unavailable when it needs reauthentication, has an active block, or has a live reservation. The router does not silently fall back to an automatically ranked account in that case; it reports `manual_account_unavailable`. Use `/quota-router use auto` to resume automatic ranking.

## Reservations and concurrency

Selection and reservation happen inside one locked state update. Foreground and primer leases use a two-minute abandonment window and renew every 40 seconds while their work remains active. Completion, error, or cancellation releases them immediately; crashed owners stop renewing and expire naturally. Two concurrent Pi controllers sharing a profile therefore cannot acquire the same free account.

Primer work renews both its singleton sweep lease and account lease. Foreground activity stops primer work so synthetic spend does not compete with a user request.

## Failure and recovery policy

- Pre-output `429`, quota, usage-limit, or rate-limit errors block the account and may rotate to another account.
- A transport `start` event is replay-safe.
- Any text, thinking, or tool-call start makes replay unsafe; later errors are forwarded without account rotation.
- A request performs at most five account attempts.
- An explicit provider retry time controls a quota block. Otherwise the latest observed reset across exhausted windows is used; without either, the estimate is one hour.
- All-limited recovery waits are abortable, recheck state at most once per minute, and stop after six hours.
- `invalid_grant` and revoked refresh tokens set `needsReauth` until a new login replaces the credentials.
- Generic network/timeout failures use a one-minute transient retry time.
- A generic pre-output `401` forces one token refresh and retries the same account before rotation.
- A forced usage refresh clears an estimated block when quota is available; otherwise the latest observed exhausted-window reset replaces the estimate.
- Reauthenticating the same Codex identity clears its persisted authentication block.

Concurrent usage refreshes for one account are coalesced. Cancelling one caller stops that caller's wait without cancelling the shared fetch needed by other callers.

When all known accounts are temporarily unavailable, recovery also rechecks the managed account list at most once per minute. A newly logged-in account or a peer's persisted block/reservation change can therefore release the wait before the original retry deadline.

## Priming policy

`/quota-router prime` obtains both confirmations for the current invocation only. It does not set `priming.enabled` or `priming.confirmedFirstUseRollingWindow`, so it cannot authorize a later idle sweep or background request.

An untouched candidate must have a fresh snapshot, 0% used in both windows, and no weekly reset timestamp. The primer sends one `.` request with no history/tools, the selected Codex model, minimum reasoning, and one output token. An unsupported selected model is rejected before usage, quota spend, or retry state changes. The primer succeeds only if a forced post-request usage refresh reveals a weekly reset timestamp. Otherwise the account waits one hour before another primer attempt.

One command sends at most one provider request. With `all`, the router skips ineligible accounts until it finds the first candidate, makes that one attempt, refreshes/records the observed quota state, and stops. Agent-settled events never schedule priming. Persistent automatic priming remains disabled pending a separate explicit action and confirmation contract.
