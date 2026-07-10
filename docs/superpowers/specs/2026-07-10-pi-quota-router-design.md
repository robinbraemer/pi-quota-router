# Pi Quota Router Design

**Date:** 2026-07-10

**Status:** Implemented

**Target:** normal Pi (`@earendil-works/pi-*`), Node.js `>=22.19.0`
**Scope:** equivalent ChatGPT Codex OAuth accounts only

## Summary

Pi Quota Router is a normal-Pi extension that keeps the user's Codex model and thinking level fixed while automatically choosing the best equivalent ChatGPT account. It maximizes useful quota before reset without sacrificing task reliability.

The router does not merely choose the lowest usage percentage. It:

1. Requires fresh quota and provider-health data.
2. Excludes accounts that cannot safely carry the expected turn.
3. Spends quota with the highest expiry urgency first.
4. Drains the account with the least weekly quota remaining when urgency is materially tied.
5. Supports explicit synthetic priming for confirmed first-use rolling windows.
6. Coordinates concurrent Pi processes so they do not stampede one account.
7. Rotates transparently only before output, where replay is safe.

## Goals

- Target normal Pi's public extension and provider APIs.
- Preserve the active Codex model, model capability, thinking level, and user expectations.
- Route automatically among equivalent Codex OAuth accounts.
- Optimize effective usable quota over time rather than evenly balancing percentages.
- Support one-shot priming when the operator explicitly confirms both quota spend and first-use rolling-window behavior for that invocation.
- Avoid starting work on an account that lacks conservative 5-hour or weekly headroom.
- Keep routing deterministic, explainable, observable, abortable, and safe under multiple Pi processes.
- Recover transparently from pre-output quota, authentication, and token-refresh failures.
- Provide a coherent `/quota-router` command family and a compact footer.
- Store credentials and state with atomic writes, explicit permissions, strict schemas, and lock protection.

## Non-goals

- Cross-provider routing in v1.
- Automatic model downgrade or upgrade.
- Comparing quota percentages across different providers or models.
- Replaying a request after any text, thinking, or tool-call event has been emitted.
- Guessing that a reset clock starts on first use without explicit operator confirmation.
- Importing cookies, launching provider CLIs, or mutating provider state merely to inspect quota.
- Cloud synchronization between machines.
- A general load balancer for arbitrary OpenAI-compatible providers.

## Reference implementations

### `victor-software-house/pi-multicodex`

Use as the primary behavioral and architectural reference:

- Replay-safe provider stream wrapper.
- Proactive usage refresh.
- Token refresh single-flight.
- Modular account manager, provider, selection, storage, commands, and footer.
- Unified command family and account-manager UI.
- Schema validation and migration discipline.

Do not inherit:

- Lowest-used-percentage routing, which balances rather than drains urgent quota.
- Raw credential writes without an atomic replace, explicit `0600`, or cross-process lock.
- Re-selecting accounts without session-score hysteresis.
- The older Pi dependency baseline and `pi-provider-utils` dependency graph.

### `Sarrius/pi-multi-account`

Borrow reliability mechanisms:

- Persisted cooldowns and invalidation state.
- Distinguishing transient auth failures from definitive revocation.
- Bounded structured diagnostic log with credential redaction.
- All-limited wake-up behavior and cancellation semantics.
- Anti-ping-pong logic, stuck-work guards, and circuit-breaker thinking.
- Account identity deduplication by stable Codex `accountId`.
- Usage freshness reconciliation when an estimated cooldown is pessimistic.
- Guarantee-driven regression tests.

Do not inherit:

- Fake provider aliases as the central routing abstraction.
- Cross-provider/model continuation machinery.
- A monolithic state machine.
- Direct, non-atomic rewrites of Pi's `auth.json`.
- Model-recency selection, which is irrelevant when v1 fixes the model.

### `kim0/pi-multicodex`

Borrow the original product intent:

- Fresh accounts should not leave a first-use rolling window dormant forever.
- Once accounts are initialized, near-reset quota should be spent first.
- A small stream wrapper can rotate before output without transcript surgery.

Do not inherit:

- Earliest-reset-only ranking, which ignores how much quota is about to expire.
- Five-minute stale snapshots that can repeatedly classify the same account as untouched.
- Missing refresh single-flight and minimal storage hardening.
- The single-file architecture.

## Considered architectures

### A. Fork Victor's repository

This is the shortest route to a working Codex-only extension. It already has the right stream boundary and operator UX.

Rejected because the new design would replace selection, persistence, dependency baseline, coordination, account identity, priming, and much of the command contract. A clean-room implementation avoids carrying compatibility and storage decisions that would immediately need migration.

### B. Register each account as a Pi provider alias

This delegates OAuth storage and refresh to Pi. Routing changes the active provider/model to an alias for the chosen account.

Rejected for v1 because it turns equivalent-account selection into model switching, complicates model identity, session display, prompt-cache behavior, and pre-output replay. It also pushes failover into agent continuation hooks even when a stream-level retry is sufficient.

### C. Clean-room override of `openai-codex` with a managed account pool

The extension mirrors normal Pi's Codex models, overrides the built-in `openai-codex` provider with a wrapper, and injects the selected account's fresh access token into the built-in Codex stream implementation.

Selected because it preserves model identity, makes pre-output retry transparent, isolates routing from transcript continuation, and provides focused module boundaries. The cost is owning a secure local OAuth account vault, which this design addresses explicitly.

## Architecture

```text
Pi prompt
   │
   ▼
openai-codex provider override
   │
   ├─ AccountVault ───────── OAuth login / refresh / atomic persistence
   ├─ UsageService ───────── fresh 5h + weekly snapshots
   ├─ ReservationStore ───── cross-process leases and write lock
   ├─ SelectionPolicy ────── eligibility → headroom → urgency → drain tie-break
   ├─ PrimingController ──── explicit one-shot synthetic primer workflow
   └─ RoutedStream ───────── built-in Codex stream + replay-safe failover
```

The provider override is the only component coupled to Pi's streaming types. Selection, quota parsing, persistence, priming decisions, and reservation logic are pure or dependency-injected modules.

## Module boundaries

### `src/extension.ts`

- Creates the controller.
- Registers the `openai-codex` provider override.
- Registers `/quota-router` and lifecycle hooks.
- Contains no routing or persistence logic.

### `src/provider.ts`

- Mirrors built-in Codex model metadata.
- Obtains Pi's built-in `openai-codex-responses` stream implementation.
- Installs `RoutedStream` without changing model ids or thinking metadata.
- Registers with a non-secret `pending-login` sentinel only to satisfy Pi's
  provider-registration contract; `RoutedStream` supplies the selected
  account's token for real requests and rejects locally with login guidance
  when the vault is empty.

### `src/router-controller.ts`

- Orchestrates vault, usage, selection, reservations, priming, and status.
- Exposes command-friendly methods with structured results.
- Owns no UI rendering.

### `src/accounts/account-vault.ts`

- Loads and validates managed OAuth accounts.
- Logs in, removes, labels, and deduplicates accounts.
- Refreshes tokens five minutes before expiry.
- Uses one in-process promise and one cross-process lock per account refresh.
- Reloads after acquiring the lock so a peer's completed refresh is reused.
- Never reads or writes Pi's `auth.json` during normal operation.

### `src/storage/atomic-json-store.ts`

- Creates the router directory with mode `0700`.
- Creates files with mode `0600`.
- Writes a same-directory temporary file, flushes it, and renames it atomically.
- Serializes writers with `proper-lockfile` and a bounded stale-lock policy.
- Removes an unfinished temporary file when a write fails without replacing a valid primary.

### `src/usage/codex-usage.ts`

- Fetches `https://chatgpt.com/backend-api/wham/usage`.
- Sends bearer access and `ChatGPT-Account-Id` only to ChatGPT.
- Parses primary and secondary usage windows, reset timestamps, plan metadata, and credits.
- Uses a ten-second abortable request timeout.
- Never returns or persists credentials in a usage snapshot.

### `src/usage/usage-service.ts`

- Caches snapshots for five minutes.
- Coalesces concurrent refreshes per account; cancelling one caller does not cancel the shared fetch for other callers.
- Keeps a last-good snapshot for 24 hours, clearly marked stale.
- Forces a fresh fetch after priming and quota errors.
- Limits concurrent upstream usage requests to two.

### `src/routing/selection-policy.ts`

- Implements the pure account-selection algorithm.
- Produces a ranked explanation for every candidate.
- Never mutates account, usage, or reservation state.

### `src/routing/reservation-store.ts`

- Persists short account leases in non-secret state.
- Keys leases by account id, process id, session id, and request id.
- Excludes leases owned by other live requests.
- Renews foreground and primer leases while their work remains active.
- Expires abandoned leases after two minutes.
- Acquires the chosen lease inside the same write lock used to re-check candidates.

### `src/priming/priming-controller.ts`

- Finds accounts confirmed as untouched with no weekly reset clock.
- Requires explicit priming policy enablement and rolling-window confirmation.
- Waits until Pi is idle and no foreground routed request is active.
- Reserves one account, sends a minimal no-tool Codex request, then force-refreshes usage.
- Marks success only when a weekly reset timestamp is observed.
- Applies a one-hour retry cooldown after an inconclusive or failed primer.
- Runs sequentially and is abortable on shutdown.

### `src/stream/routed-stream.ts`

- Selects and reserves an account before invoking the built-in Codex stream.
- Refreshes its OAuth token before use.
- Treats `start` as transport metadata, not model output.
- Marks replay unsafe only after text, thinking, or tool-call content starts.
- On a pre-output quota/auth error, blocks the account, releases the lease, and retries another account up to five times.
- On any post-output error, forwards the error unchanged without rotation.
- If all accounts are temporarily blocked before output, waits abortably for the earliest recovery for at most six hours.

### `src/status/status-controller.ts`

- Renders a compact footer with active account, 5-hour remaining, weekly remaining, reset countdown, urgency, and routing mode.
- Uses cached data immediately; normal selection and explicit refreshes populate the cache.
- Keeps rendering independent from routing success.

### `src/commands/commands.ts`

- Provides one `/quota-router` family.
- Routes to structured controller calls.
- Keeps UI code separate from state mutation.

## Data model

### Account vault

Path: `~/.pi/agent/pi-quota-router/accounts.json`

```typescript
interface AccountVaultFile {
  version: 1;
  accounts: ManagedCodexAccount[];
}

interface ManagedCodexAccount {
  id: string;
  label: string;
  accountId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  needsReauth?: boolean;
}
```

`id` is a stable truncated SHA-256 of `accountId`, prefixed with `codex-`. Duplicate `accountId` logins update the existing account instead of creating another quota slot and clear any persisted authentication block.

### Config

Path: `~/.pi/agent/pi-quota-router/config.json`

```typescript
interface RouterConfig {
  version: 1;
  enabled: boolean;
  manualAccountId?: string;
  usageFreshnessMs: number;
  maxRotationAttempts: number;
  maxRecoveryWaitMs: number;
  reservationTtlMs: number;
  scoreHysteresisRatio: number;
  headroom: {
    shortWindowMinimumPercent: number;
    weeklyMinimumPercent: number;
  };
  priming: {
    enabled: boolean;
    confirmedFirstUseRollingWindow: boolean;
    maximumPerSweep: number;
    retryCooldownMs: number;
  };
}
```

Defaults:

- `enabled`: `true`
- `usageFreshnessMs`: `300000`
- `maxRotationAttempts`: `5`
- `maxRecoveryWaitMs`: `21600000`
- `reservationTtlMs`: `120000`
- `scoreHysteresisRatio`: `0.10`
- `headroom.shortWindowMinimumPercent`: `10`
- `headroom.weeklyMinimumPercent`: `3`
- `priming.enabled`: `false`
- `priming.confirmedFirstUseRollingWindow`: `false`
- `priming.maximumPerSweep`: `1`
- `priming.retryCooldownMs`: `3600000`

Synthetic priming requires both priming booleans. `/quota-router prime` explains that the action deliberately spends a small amount of quota and records both confirmations before attempting any account.

### Runtime state

Path: `~/.pi/agent/pi-quota-router/state.json`

Contains no credentials:

- Account cooldowns and their source.
- Primer status and retry time.
- Reservations.
- Last selection explanation.
- Schema version.

The version-one schema also reserves `usageSnapshots` and `events` arrays. The current controller keeps usage snapshots in memory and writes operational diagnostics to `events.ndjson`, so those state arrays remain empty.

## Selection policy

### Inputs

For each account:

- Freshness and fetch result.
- 5-hour used percentage and reset time.
- Weekly used percentage and reset time.
- Account availability, auth health, and cooldown.
- Primer state.
- Reservation state.
- Manual override.
- Current account for hysteresis.

### Eligibility

An account is ineligible when:

- It needs reauthentication.
- It is in a live quota/auth cooldown.
- Another live request owns its reservation.
- Its usage is unknown or older than 24 hours.
- Its remaining 5-hour quota is below 10%.
- Its remaining weekly quota is below 3%.
- It is untouched without a weekly reset clock and priming is disabled or unconfirmed.

Stale-but-last-good data between five minutes and 24 hours is eligible only as a conservative fallback after all fresh candidates are exhausted. Its effective remaining percentages are reduced by five points before applying headroom checks.

### Urgency

For a fresh eligible account with a weekly reset:

```text
weeklyRemaining = clamp(1 - weeklyUsedPercent / 100, 0, 1)
hoursToReset = max((weeklyResetAt - now) / 3_600_000, 0.25)
urgency = weeklyRemaining / hoursToReset
```

Higher urgency wins because it represents more quota that must be spent per hour to avoid expiring unused.

### Tie-breakers

Candidates within 10% of the highest urgency are materially tied. Resolve ties in this order:

1. Least weekly remaining quota that still passes the 3% headroom floor.
2. Most 5-hour remaining quota.
3. Current account, to preserve prompt-cache affinity.
4. Stable account id lexical order for deterministic behavior.

The current account is retained when its urgency is within 10% of the winner and it passes all eligibility checks. This avoids account churn for negligible score improvements.

### Manual override

A manually selected account bypasses automatic freshness, untouched-clock, and headroom checks, but remains unavailable when it needs reauthentication, has an active block, or has a live reservation. The override stays configured until the operator runs `/quota-router use auto`; the router never silently substitutes an automatically ranked account.

### Headroom limitation

Codex usage endpoints expose percentages but not a reliable conversion from an arbitrary agent turn to quota percentage. V1 therefore uses explicit conservative floors rather than pretending to predict exact turn cost. Selection explanations state this limitation.

The state model leaves room for a future observed-debit estimator, but no estimator is part of v1.

## Priming policy

Priming is intentional quota spend, not quota inspection.

An account is a priming candidate only when a fresh usage snapshot shows:

- 0% used in both active windows.
- No observed weekly reset timestamp.
- Healthy authentication.
- No cooldown, reservation, or prior successful primer.

The operator must confirm both deliberate quota spend and the first-use rolling-window assumption for every `/quota-router prime` invocation. Those confirmations are ephemeral and do not mutate the persistent priming booleans. The extension does not ship a provider claim that first use always starts the window.

The synthetic primer:

- Uses the current Codex model to avoid crossing capability pools.
- Uses no tools and no conversation history.
- Uses the lowest supported reasoning level.
- Sends `.` as the prompt with a one-token output budget.
- Runs only while Pi is idle.
- Sends at most one provider request per confirmed command, including `prime all`.
- Holds a reservation for the full request.
- Force-refreshes usage after completion.
- Succeeds only after observing a weekly reset timestamp.

If the reset timestamp remains absent, the account is not marked primed. It receives a one-hour primer retry cooldown and is not used for foreground work unless manually selected.

The command force-refreshes and records the observed quota state, then stops. Agent settlement does not schedule background primer work. Persistent automatic priming remains disabled unless a separate explicit action and confirmation contract is added later.

## Quota and failure handling

### Quota classification

Classify quota/rate-limit failures from:

- HTTP-equivalent error metadata when exposed.
- `429`, `quota`, `usage limit`, `rate limit`, `too many requests`, and Codex usage-limit codes.

After a quota failure, force-refresh usage. An explicit provider retry time controls the block; otherwise use the latest reset among exhausted windows. If neither is available, use a one-hour cooldown. Every observed deadline is capped at six hours.

An explicit forced refresh reconciles an estimated cooldown: available quota clears it, while the latest observed exhausted-window reset replaces the estimate.

### Authentication classification

- Refresh expired tokens before the request.
- Coalesce concurrent refreshes.
- On the first generic `401`, force-refresh once and retry the same account before rotating.
- Definitive `invalid_grant`, revoked-token, malformed access-token, or identity-mismatch responses mark the account `needsReauth` immediately.
- A transient refresh network failure causes a one-minute cooldown, not permanent invalidation.
- No credential value appears in logs, notifications, state, or thrown messages.

### Replay boundary

The wrapper may replay only when no text, thinking, or tool-call block has started. A transport `start` event alone does not make replay unsafe.

After model-visible output begins, the wrapper forwards the provider error and never switches accounts inside that turn. This avoids duplicated text, reasoning, or tool effects.

### All accounts unavailable

Before any output, the wrapper waits for the earliest known recovery when:

- At least one account is temporarily blocked rather than permanently invalid.
- The wait is at most six hours.
- The caller's abort signal remains active.

The wait re-checks persisted state and the managed account list at most once per minute, so a peer process login, refresh, usage correction, or reservation release can wake the request before the original retry deadline. Escape/user abort ends the wait immediately.

## Concurrency model

Multiple Pi processes share the same vault and state directory.

- Every mutation occurs under a file lock.
- Writers reload and revalidate after locking.
- Account selection and lease acquisition are one atomic critical section.
- A selected account is unavailable to other request ids until release or lease expiry.
- OAuth refresh uses an account-specific lock and re-check-after-lock.
- Usage fetches are coalesced per account within a process.
- Primer sweeps use a singleton lease, so only one process primes at a time.
- Locks have bounded acquisition time and stale-owner recovery.
- Lock timeout never causes an unsafe write; the operation returns a visible retryable error.

## Commands and UX

One command family:

- `/quota-router` — show compact status and the highlighted command guide.
- `/quota-router help` — show the same status and command guide.
- `/quota-router status` — print compact active-account and quota status.
- `/quota-router list` — list managed ids, labels, and reauthentication state.
- `/quota-router accounts` — alias of `list`.
- `/quota-router login [label]` — add or update a Codex OAuth account.
- `/quota-router use <account|auto>` — set or clear manual override.
- `/quota-router refresh [account|all]` — refresh OAuth if needed and force fresh quota usage.
- `/quota-router prime [account|all]` — confirm one minimal request, refresh the selected account's quota, then stop.
- `/quota-router policy` — print the active routing, headroom, and priming configuration.
- `/quota-router reset <cooldowns|reservations|priming|all>` — clear recoverable state without deleting credentials.
- `/quota-router verify` — validate persisted schemas and required file permissions.
- `/quota-router path` — show vault, config, state, and log paths.
- `/quota-router log [on|off]` — show or toggle the bounded diagnostic log.

All read-only commands work in non-interactive mode. Mutating commands return exact summaries and never silently discard account state.

The footer shows:

```text
Codex · work@example · 5h 72% · 7d 41%/18h · urgent 0.023/h · auto
```

The final field is `auto`, `manual`, or `login`; unknown usage or reset values render as `?`.

## Persistence and security

- Router directory: `0700`.
- Credential, config, state, and log files: `0600`.
- No credentials in state, logs, error messages, or session entries.
- Logs redact bearer tokens, JWT-like strings, API-key-like strings, and long opaque identifiers defensively.
- Diagnostic log is bounded to 4 MiB with one rotated predecessor.
- Account labels are treated as untrusted display strings and normalized before rendering.
- Usage calls go only to the Codex usage endpoint.
- OAuth calls use Pi's exported Codex OAuth implementation.
- The extension does not mutate Pi's `auth.json`.
- The extension does not invent local encryption. Platform credential storage can be a later migration when Pi exposes an appropriate multi-account interface.

## Observability

Each atomic selection persists a credential-free `lastSelection` explanation in `state.json`, including candidate freshness, remaining percentages, urgency, eligibility reasons, and the tie-break result. The bounded `events.ndjson` log records selected accounts, quota/auth invalidations, and detached primer failures with managed ids rather than raw Codex account ids. `/quota-router log off` disables new diagnostic entries for the current controller process.

## Testing strategy

### Pure policy tests

- Near-reset high remaining quota beats lower remaining quota with a distant reset.
- Similar urgency drains the least weekly remaining account.
- Short-window headroom vetoes a weekly winner.
- Manual selection wins while healthy.
- Stale data is penalized and fresh data wins.
- Untouched/no-clock accounts are excluded until primed or manually selected.
- Hysteresis retains the current account within the 10% band.
- Deterministic account id resolves complete ties.

### Priming tests

- No primer runs without both confirmations.
- One singleton primer runs across concurrent controllers.
- One confirmed command sends at most one provider request and never enables future background work.
- Primer uses no history or tools.
- Primer does not block a foreground request.
- Successful confirmation requires a newly observed weekly reset.
- Inconclusive primer applies a one-hour retry cooldown.
- Shutdown aborts primer work and releases leases.

### Stream tests

- Pre-output quota failure rotates and replays once.
- A transport `start` event does not prohibit replay.
- Text, thinking, or tool-call start prohibits replay.
- Abort cancels the caller's usage wait, token refresh wait, provider stream, and recovery sleep; a shared usage fetch remains alive for other callers.
- Maximum rotation attempts is enforced.
- All-limited wait wakes on the first recovered account.
- No permanent-invalid account participates in waiting.

### Auth and concurrency tests

- Concurrent refresh callers invoke the OAuth endpoint once.
- Concurrent usage callers share one refresh even when one caller aborts.
- Cross-process refresh reuses the peer's newly persisted token.
- Selection plus reservation is atomic.
- Abandoned leases expire.
- Two controllers never reserve the same account simultaneously.
- Duplicate `accountId` login updates rather than duplicates.
- Successful reauthentication clears the account's permanent auth block.
- Forced fresh non-exhausted usage clears an estimated cooldown.
- Recovery waiting notices an account added by a peer.

### Storage tests

- New directories and files receive exact permissions.
- Interrupted temporary writes leave the primary readable.
- Invalid JSON does not overwrite the last valid file.
- Abandoned temporary files do not replace a valid primary.
- Lock acquisition timeout returns a visible error.
- Secrets never appear in state or logs.

### Compatibility tests

- Mirrored Codex model metadata remains unchanged.
- Provider and event names remain `openai-codex`.
- Thinking levels pass through unchanged.
- Package installs outside a Pi monorepo and resolves only public exports.

## Toolchain and dependency policy

- TypeScript with erasable syntax.
- Bun `1.3.7` or newer for dependency management, scripts, tests, and the
  committed `bun.lock`.
- Node.js `>=22.19.0` runtime compatibility because normal Pi loads the
  extension inside Pi's Node process; shipped code must not depend on Bun-only
  runtime APIs.
- `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` as peer dependencies, with `0.80.6` as the initial development baseline.
- Direct runtime dependencies pinned exactly.
- `proper-lockfile@4.1.2` for cross-process file locking.
- `zod@4.3.6` for persisted-schema validation.
- Bun's built-in `bun:test` runner for unit and integration tests.
- Biome and `tsgo`, invoked through Bun scripts, for lint and type validation.
- No dependency on `pi-provider-utils`.
- Installation and CI use `bun install --frozen-lockfile --ignore-scripts` unless a reviewed dependency requires lifecycle scripts.

## Release gates

A release is blocked unless:

- Lint and typecheck pass with zero diagnostics.
- All tests pass.
- Production dependency audit has no unresolved high or critical advisory reachable from shipped code.
- `bun pm pack --dry-run --ignore-scripts` contains only the declared package files.
- A clean external install can load the extension and list mirrored Codex models.
- End-to-end fake-provider tests prove selection, reservation, pre-output rotation, post-output non-replay, primer confirmation, and abort handling.
- README behavior matches the executable selection policy tests.

## Success criteria

- Equivalent Codex account selection requires no routine user decision.
- Routing explanations identify health, freshness, headroom, urgency, and tie-breaks.
- High remaining quota near reset is spent before less urgent quota.
- Similar-urgency accounts drain the least weekly remaining safe account.
- Synthetic primer spend occurs only after explicit confirmation and is verified from fresh usage.
- No task starts below the configured 5-hour or weekly headroom floor unless manually forced.
- Parallel Pi processes do not select the same free account concurrently.
- Token refresh races cannot burn a rotating refresh token.
- Failover before output is transparent; failover after output never replays.
- The extension never changes the user's model or thinking level.
