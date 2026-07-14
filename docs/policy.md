# Routing policy

This document describes quota selection, reservation, and failure-recovery behavior. Percentages below mean quota remaining unless explicitly called “used.”

## Automatic eligibility

Automatic routing rejects an account when any of these conditions is true:

- routing is disabled;
- OAuth is marked `needsReauth`;
- a live quota/auth/transient block exists;
- another request holds a live reservation;
- no usage snapshot is available;
- the snapshot is more than 24 hours old;
- the weekly window or its reset timestamp is unknown;
- the weekly reset timestamp has elapsed and fresh post-reset usage has not yet been obtained;
- the account is untouched and has not obtained a reset clock through confirmed priming;
- a reported 5-hour window has less than 10% remaining quota;
- weekly remaining quota is below 3%.

Usage younger than five minutes is fresh. Data from five minutes through 24 hours is stale fallback data. Snapshots are persisted for restart-safe cache and fallback behavior, but any reported 5-hour or weekly reset immediately expires the cache even inside the normal freshness period. The router uses a fresh eligible tier whenever one exists. Only when no fresh account is eligible may stale data participate, with five percentage points subtracted from every reported window before the headroom checks.

Provider position is not window identity when duration metadata exists. `18000` seconds is classified as five-hour and `604800` seconds as weekly, regardless of primary/secondary position. Durationless responses retain the legacy positional mapping. A weekly-only response is valid; the router does not invent a short quota or apply the 10% short floor. Unknown explicit durations fail parsing instead of being guessed.

The headroom floors are conservative safety margins, not predicted task costs. Codex exposes quota percentages but no dependable mapping from an arbitrary future turn to percentage cost.

## Urgency and ordering

For every eligible account:

```text
weeklyRemainingFraction = clamp(1 - weeklyUsedPercent / 100, 0, 1)
hoursToReset = max((weeklyResetAt - now) / 3_600_000, 0.25)
urgency = weeklyRemainingFraction / hoursToReset
```

Higher urgency wins. It is the fraction of the weekly allowance that must be consumed per hour to avoid expiring unused. Thus an account with more remaining quota and fewer days left normally wins, instead of accounts being equalized by used percentage.

The top 10% urgency band is hysteresis/tie territory. Its current account is the account that last completed a routed request, not merely the account most recently shown after login or selected for a failed attempt:

1. If the current account remains eligible and is within 10% of the top urgency, retain it.
2. Otherwise consider all candidates within 10% of the top urgency.
3. Prefer the least weekly quota remaining that is still above the 3% floor.
4. When every tied candidate reports it, prefer the most 5-hour quota remaining.
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
- When no other live block governs the account, fresh usage showing an exhausted window creates a quota block until the earliest future reset. A cached snapshot is refreshed as soon as either recorded reset time elapses.
- A transport `start` event is replay-safe.
- Any text, thinking, or tool-call start makes replay unsafe; later errors are forwarded without account rotation.
- A provider attempt derives one request-scoped timeout from the public `SimpleStreamOptions.timeoutMs` option, passes that effective value to Codex, and uses it for both silence phases. An omitted value defaults to five minutes; finite nonnegative values retain Pi's validation contract, then clamp to the range from 30 seconds through five minutes. The value is not persisted, so strict version-one configs remain rollback-readable.
- Before model-visible output, each nonterminal provider event renews the pre-output deadline; a timeout aborts/releases that attempt and may rotate without recording quota, auth, or account-health failure. Once text, thinking, or a tool-call lifecycle event crosses the replay boundary, each later nonterminal event renews the post-output idle deadline; its timeout aborts/releases and emits one sanitized terminal error without replay or rotation.
- User cancellation remains `aborted` and wins deadline races. Deadline, completion, heartbeat loss, and cancellation cleanup is idempotent.
- A request performs at most five account attempts.
- An explicit provider retry time controls a quota block. Otherwise the latest observed reset across exhausted windows is used; without either, the estimate is one hour.
- If fresh selection finds no eligible account, the foreground stream emits one sanitized terminal error immediately. A later retry performs a new selection pass and can use recovered quota or account health.
- `invalid_grant`, a usage credential rejected again after forced refresh, and revoked refresh tokens set `needsReauth` only while the rejected credential is still current. A concurrent successful re-login wins and remains healthy.
- Generic network/timeout failures use a one-minute transient retry time.
- A generic `401` from usage collection or a pre-output routed provider call forces one token refresh and retries the same account before rotation.
- A forced usage refresh clears an estimated quota block when quota is available; otherwise the latest observed exhausted-window reset replaces the estimate. Usage reconciliation never clears authentication or transient blocks.
- Reauthenticating the same Codex identity clears its persisted authentication block.

Concurrent ordinary usage refreshes for one account are coalesced. A forced refresh requested during an in-flight fetch queues one follow-up fetch, which concurrent forced callers share. Cancelling one caller stops that caller's wait without cancelling either shared fetch needed by other callers.

OAuth token refresh is likewise single-flight per account within a process. Cancelling one caller stops only that caller's wait, while the shared refresh continues for other callers.

Foreground routing never waits for future quota recovery. `maxRecoveryWaitMs` remains in the strict version-one config only for file and rollback compatibility; it has no effect on a foreground request. The standalone recovery helper remains tested but is not wired into routed streams.

## Priming policy

`/quota-router prime` obtains both confirmations for the current invocation only. It does not set `priming.enabled` or `priming.confirmedFirstUseRollingWindow`, so it cannot authorize a later idle sweep or background request.

An untouched candidate must have a reported fresh five-hour window at 0% used, a weekly window at 0% used, and no weekly reset timestamp. A weekly-only account with an active reset clock is already started and is never primed. The primer sends one `.` request with no history/tools, the selected Codex model, minimum reasoning, and one output token. An unsupported selected model is rejected before usage, quota spend, or retry state changes. Every non-aborted provider attempt is followed by a forced usage refresh, even when the provider reports an error. An observed weekly reset timestamp confirms the account, but a provider error still returns `failed`; without an observed timestamp, failed and inconclusive attempts wait one hour before another primer attempt.

One command sends at most one provider request. With `all`, the router skips ineligible accounts until it finds the first candidate, makes that one attempt, refreshes/records the observed quota state, and stops. Agent-settled events never schedule priming. Persistent automatic priming remains disabled pending a separate explicit action and confirmation contract.
