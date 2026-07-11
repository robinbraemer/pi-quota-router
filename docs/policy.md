# Routing policy

This document describes the behavior implemented and tested in `src/routing/selection-policy.ts`. Percentages below mean quota remaining unless explicitly called “used.”

## Automatic eligibility

Automatic routing rejects an account when any of these conditions is true:

- routing is disabled;
- OAuth is marked `needsReauth`;
- a live quota/auth/transient block exists;
- an account primer holds a live lease;
- no usage snapshot is available;
- the snapshot is more than 24 hours old;
- the weekly window or its reset timestamp is unknown;
- the weekly reset timestamp has elapsed and fresh post-reset usage has not yet been obtained;
- the account is untouched and has not obtained a reset clock through confirmed priming;
- 5-hour remaining quota is below 10%;
- weekly remaining quota is below 3%.

The exported `Candidate` type represents the exclusive fence as `primerLease?: Reservation`; foreground leases are lifecycle records, not candidate-health input. A live primer rejection uses `primer_active`, replacing the former generic `reserved` selection rejection.

Usage younger than five minutes is fresh. Data from five minutes through 24 hours is stale fallback data. Snapshots are persisted for restart-safe cache and fallback behavior, but a recorded 5-hour or weekly reset immediately expires the cache even inside the normal freshness period. The router uses a fresh eligible tier whenever one exists. Only when no fresh account is eligible may stale data participate, with five percentage points subtracted from both remaining windows before the headroom checks.

The headroom floors are conservative safety margins, not predicted task costs. Codex exposes quota percentages but no dependable mapping from an arbitrary future turn to percentage cost.

## Urgency and ordering

For every eligible account:

```text
weeklyRemainingFraction = clamp(1 - weeklyUsedPercent / 100, 0, 1)
hoursToReset = max((weeklyResetAt - now) / 3_600_000, 0.25)
urgency = weeklyRemainingFraction / hoursToReset
```

Higher urgency wins. It is the fraction of the weekly allowance that must be consumed per hour to avoid expiring unused. Thus an account with more remaining quota and fewer days left normally wins, instead of accounts being equalized by used percentage.

The top 10% urgency band is hysteresis/tie territory. Its current account is the account that last completed a routed request in the same effective Pi session and controller instance, not merely the account most recently shown after login or selected for a failed attempt. Affinity is not persisted or shared between sessions or controllers, and shutdown clears it:

1. If the current account remains eligible and is within 10% of the top urgency, retain it.
2. Otherwise consider all candidates within 10% of the top urgency.
3. Prefer the least weekly quota remaining that is still above the 3% floor.
4. Then prefer the most 5-hour quota remaining.
5. Finally use lexical managed account id for deterministic selection.

Stable managed ids are truncated SHA-256 derivatives of raw Codex account ids. Raw ids never enter selection logs.

## Manual routing

`/quota-router use <account>` sets a deliberate manual override. The router does not fetch usage before selecting that account, and the account bypasses automatic freshness, untouched-clock, and 10%/3% headroom checks. This makes the command genuinely forceful.

The manual account is still unavailable when it needs reauthentication, has an active block, or has a live account primer lease. Foreground leases are advisory and do not veto the manual account. The router does not silently fall back to an automatically ranked account in an unavailable case; it reports `manual_account_unavailable`. Use `/quota-router use auto` to resume automatic ranking.

## Reservations and concurrency

Selection and lease creation happen inside one locked state update. Each foreground request appends a distinct lease even when other foreground leases already exist for the selected account; those leases are advisory for foreground eligibility and there is no concurrency cap. Their independent tokens keep renewal, cancellation, failure, and release request-local.

Primer fencing remains exclusive and owner-agnostic. Any live account primer lease vetoes automatic and manual foreground selection until release or expiry. Conversely, any live foreground lease for an account prevents priming that account, including a lease left by a crashed process, so synthetic spend cannot overlap user work. Primer work renews both its singleton sweep lease and account lease, and foreground activity stops primer work.

Foreground and primer leases use a two-minute abandonment window and renew every 40 seconds while their work remains active. Completion, error, or cancellation releases only that request's lease immediately. A crashed foreground owner stops renewing: its lease continues to fence primer acquisition until expiry but does not veto another foreground request. Losing renewal terminates only the affected request.

The persisted config and runtime-state schemas remain version 1. Multiple foreground leases for one account use the existing reservation array and require no migration or startup rewrite. Forward updates and rollbacks should restart all Pi processes sharing a profile together. During a mixed-version interval, both versions remain primer-safe, but an old controller still treats every live foreground lease as exclusive while a new controller treats it as advisory, so foreground selection is intentionally asymmetric until the restart completes.

## Failure and recovery policy

- Pre-output `429`, quota, usage-limit, or rate-limit errors block the account and may rotate to another account.
- When no other live block governs the account, fresh usage showing an exhausted window creates a quota block until the earliest future reset. A cached snapshot is refreshed as soon as either recorded reset time elapses.
- A transport `start` event is replay-safe.
- Any text, thinking, or tool-call start makes replay unsafe; later errors are forwarded without account rotation.
- A request performs at most five account attempts. An account that failed earlier may become eligible again after its cooldown expires during recovery.
- An explicit provider retry time controls a quota block. Otherwise the latest observed reset across exhausted windows is used; without either, the estimate is one hour.
- All-limited recovery waits are abortable, recheck state at most once per minute, and stop at the configured recovery limit (six hours by default).
- `invalid_grant`, a usage credential rejected again after forced refresh, and revoked refresh tokens set `needsReauth` only while the rejected credential is still current. A concurrent successful re-login wins and remains healthy.
- Generic network/timeout failures use a one-minute transient retry time.
- A generic `401` from usage collection or a pre-output routed provider call forces one token refresh and retries the same account before rotation.
- A forced usage refresh clears an estimated quota block when quota is available; otherwise the latest observed exhausted-window reset replaces the estimate. Usage reconciliation never clears authentication or transient blocks.
- Reauthenticating the same Codex identity clears its persisted authentication block.

Concurrent ordinary usage refreshes for one account are coalesced. A forced refresh requested during an in-flight fetch queues one follow-up fetch, which concurrent forced callers share. Cancelling one caller stops that caller's wait without cancelling either shared fetch needed by other callers.

OAuth token refresh is likewise single-flight per account within a process. Cancelling one caller stops only that caller's wait, while the shared refresh continues for other callers.

When all known accounts are temporarily unavailable, recovery rechecks persisted blocks, live account primer leases, and the managed account list at most once per minute. Foreground leases do not delay recovery. It resumes as soon as any recoverable account becomes available or a new account is logged in. Repeated recovery waits within one routed request share one cumulative configured deadline rather than restarting the limit.

## Priming policy

`/quota-router prime` obtains both confirmations for the current invocation only. It does not set `priming.enabled` or `priming.confirmedFirstUseRollingWindow`, so it cannot authorize a later idle sweep or background request.

An untouched candidate must have a fresh snapshot, 0% used in both windows, and no weekly reset timestamp. The primer sends one `.` request with no history/tools, the selected Codex model, minimum reasoning, and one output token. An unsupported selected model is rejected before usage, quota spend, or retry state changes. Every non-aborted provider attempt is followed by a forced usage refresh, even when the provider reports an error. An observed weekly reset timestamp confirms the account, but a provider error still returns `failed`; without an observed timestamp, failed and inconclusive attempts wait one hour before another primer attempt.

One command sends at most one provider request. With `all`, the router skips ineligible accounts until it finds the first candidate, makes that one attempt, refreshes/records the observed quota state, and stops. Agent-settled events never schedule priming. Persistent automatic priming remains disabled pending a separate explicit action and confirmation contract.
