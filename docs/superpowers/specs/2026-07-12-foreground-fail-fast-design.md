# Foreground Quota Fail-Fast Design

**Date:** 2026-07-12
**Status:** Approved by delegated product judgment

## Problem

Pi Quota Router currently keeps a foreground provider stream open when every managed Codex account is unavailable but at least one persisted block has a future retry time. The routed stream calls `waitForRecovery`, which sleeps and rechecks persisted state for up to six hours without producing a terminal stream event.

The production `2ndmate-akua-secondmate` session demonstrated the failure mode:

- one foreground turn remained unresolved for 19.5 minutes until abort;
- another remained unresolved for 90.6 minutes until abort;
- the current incident remained unresolved after its final tool results even though Herdr continued to report only a working Pi process;
- no provider child process existed because the pending work lived inside the router's asynchronous recovery wait.

This behavior conflicts with the extension's purpose. The router should choose a usable equivalent account and perform replay-safe pre-output failover. It should not become a scheduler that holds an old user or supervisor request until future quota appears.

## Considered approaches

### A. Fail fast after fresh selection — selected

Keep fresh usage collection, policy evaluation, reservations, and replay-safe rotation. When selection yields no eligible account, terminate the foreground stream immediately with a sanitized typed error. A later user action or supervisor wake performs a new fresh selection and can use recovered quota.

This preserves deterministic request ownership, cancellation, replay safety, and clear Herdr state.

### B. Short foreground grace period — rejected

Wait a few seconds for transient blocks or account additions before failing. This reduces the worst-case delay but still turns known unavailability into ambiguous `working` state and introduces timing-dependent behavior.

### C. Active quota polling and delayed resume — rejected

Refresh usage repeatedly while the old request remains open and resume it after recovery. This increases provider traffic and complicates cancellation, duplicate supervisor wakes, request freshness, and replay ownership. It also contradicts the requested exit-on-unavailability behavior.

## Behavioral contract

1. Each foreground request performs the existing fresh account evaluation.
2. The router may rotate among accounts only before model-visible output and only up to `maxRotationAttempts`.
3. If selection has no eligible account, the routed stream emits exactly one terminal error and closes immediately.
4. A selection failure is distinct from a provider-attempt failure:
   - `no_eligible_accounts` reports `No Codex account is currently eligible; quota, usage data, or account health must recover before retrying`.
   - `manual_account_unavailable` reports `The selected Codex account is currently unavailable`.
   - other selection reasons report `No Codex account is available: <reason>` using the router's internal non-secret reason.
5. The error contains no account id, label, token, provider payload, or raw persisted state.
6. A later request starts a new selection pass and therefore detects newly recovered usage normally.
7. Foreground streams never call `waitForRecovery` and never create a recovery deadline.

## Compatibility

The version-one `maxRecoveryWaitMs` configuration field remains accepted and persisted so existing strict `config.json` files keep loading and rollback remains possible. It becomes a reserved compatibility field with no effect on foreground routing. Removing it requires a future versioned configuration migration and is outside this fix.

The standalone recovery helper remains available only if another non-foreground workflow needs it later; this change removes it from the foreground routed-stream dependency contract. No credential, state, reservation, or event schema changes are required.

## Components

### Routed stream

`src/stream/routed-stream.ts` will stop invoking a recovery waiter on an unavailable selection. It will construct a typed `RouteUnavailableError`, exit the attempt loop, and emit the existing sanitized terminal error event.

The error sanitizer will preserve the approved `RouteUnavailableError` messages while continuing to collapse arbitrary provider failures to `No Codex account completed the request`.

### Router controller

`src/router-controller.ts` will no longer supply `recoveryDeadline` or `waitForRecovery` to the foreground stream. Fresh usage selection, block reconciliation, reservation handling, rotation, and account-affinity behavior remain unchanged.

### Documentation

README, policy/design provenance, and troubleshooting material will state that foreground routing fails fast after fresh selection. They will no longer instruct users that an active foreground request waits up to six hours. The compatibility field remains documented as reserved for version-one file compatibility.

## Testing strategy

Strict RED → GREEN TDD will cover:

1. A routed stream receiving recoverable unavailable accounts terminates immediately without invoking any recovery waiter.
2. `no_eligible_accounts` produces the exact sanitized actionable error.
3. Manual-account unavailability produces its distinct sanitized error.
4. Arbitrary provider diagnostics remain collapsed and secret-free.
5. A controller configured with the legacy six-hour value and a future quota block returns promptly instead of waiting.
6. Pre-output quota rotation still succeeds when another account is eligible.
7. Post-output failures still never replay.
8. Version-one configuration containing `maxRecoveryWaitMs` remains valid.
9. Full unit, integration, end-to-end, type, lint, format, secret, package, and isolated Pi-load gates pass.

## Operational rollout

After validation and PR creation:

1. Pin the local Pi package to the exact fixed commit.
2. Refresh the Pi Git package cache.
3. Abort the already-pending `2ndmate-akua-secondmate` foreground response; an in-flight closure cannot acquire new extension code.
4. Reload extensions in the same Pi process and preserved session.
5. Allow the next watcher wake to run and verify Herdr receives a terminal quota error promptly rather than remaining `working`.
6. Confirm original Pi PID and session file remain unchanged.

No process restart, credential change, cooldown reset, provider request replay, or account mutation is part of the rollout.
