# Duration-Aware Codex Usage Windows Design

**Date:** 2026-07-12
**Status:** Approved through the active fix-and-rollout goal

## Problem

Pi Quota Router assumes that `rate_limit.primary_window` is always the five-hour limit and `secondary_window` is always the weekly limit. The live Codex provider now returns a single primary window with an explicit duration of `604800` seconds (seven days) and no secondary window. The router discards that duration, stores the seven-day window as `shortWindow`, reports `5h 99%`, leaves `weeklyWindow` absent, and rejects the otherwise healthy account as `weekly_window_unknown`.

Live evidence after a forced refresh showed:

- account A: primary used 1%, reset 2026-07-19 21:31 CEST, no secondary window;
- account B: primary used 3%, reset 2026-07-19 20:58 CEST, no secondary window;
- the provider/RPC representation explicitly reports `windowSeconds: 604800`;
- automatic selection rejected account A as `weekly_window_unknown` and account B as `blocked`;
- the list/status UI mislabeled the lone seven-day window as five-hour quota.

PR #6 correctly made this state terminate promptly instead of hanging. It did not correct the provider-window classification.

## Considered approaches

### A. Classify explicit durations and model an absent short window — selected

Parse the provider's duration metadata, classify known five-hour and seven-day windows independent of primary/secondary position, and make the short window optional. A weekly-only response is valid input. Weekly urgency remains authoritative and the short-headroom floor applies only when the provider actually reports a short limit.

This is semantically correct, does not invent quota, survives reversed window positions, and makes the UI honest.

### B. Infer window kind from time remaining — rejected

Treat a reset far in the future as weekly. This fails near a weekly reset and after clock skew because time remaining is not window duration.

### C. Duplicate the weekly window into the required short field — rejected

This preserves the existing persisted shape but invents a five-hour semantic, displays false information, and incorrectly applies the 10% short-window floor to weekly quota.

## Provider classification contract

The parser reads `limit_window_seconds` from the HTTP shape and `windowDurationMins` from the camel-case/RPC-compatible shape. It recognizes exactly:

- `18000` seconds as the five-hour short window;
- `604800` seconds as the seven-day weekly window.

Window position is not authoritative when a recognized duration is present. Thus a weekly primary window is stored only as `weeklyWindow`, and a short secondary window is stored only as `shortWindow`.

For backward compatibility, a window with no duration metadata keeps its legacy positional meaning: primary is short and secondary is weekly. A window with explicit but unknown duration is not guessed. Duplicate windows for the same recognized kind or an input that yields no usable windows raise `CodexUsageParseError` rather than selecting arbitrary data.

Both snake-case and camel-case percentage/reset/duration names are accepted only where already represented by the two provider surfaces. Numeric values remain finite numbers; this fix does not add permissive string coercion.

## Usage model and persistence

`UsageSnapshot.shortWindow` becomes optional. `weeklyWindow` remains optional at the type boundary because legacy durationless primary-only responses are still preserved conservatively, but automatic routing continues to require a weekly window and reset timestamp.

The runtime state file moves from version 1 to version 2 because a persisted weekly-only snapshot cannot satisfy the old required `shortWindow` shape. The state schema:

- accepts strict version-one files;
- transforms version-one state to version two in memory;
- writes strict version-two state after the next mutation;
- keeps all blocks, reservations, priming state, selection evidence, and snapshots;
- changes only `UsageSnapshot.shortWindow` from required to optional.

The credential vault and router config remain version one. Runtime state contains no credentials and is rebuildable. An older extension cannot read version-two runtime state; rollback requires preserving credentials/config and recreating only `state.json`. This incompatibility is explicit rather than silently changing a version-one schema.

## Consumer behavior

### Freshness and recovery

Cache expiry checks each reported window independently. Quota-block derivation considers only reported windows, so a weekly-only exhausted window blocks until its weekly reset without inventing a short reset.

### Automatic selection

Weekly quota and its future reset remain required because weekly urgency is the extension's selection purpose. If a short window exists, the configured 10% short-headroom floor and stale-data penalty apply normally. If it is absent, no short-headroom veto is applied; the short-window tie-break runs only when every tied candidate reports that window.

Candidate explanations omit `shortWindowRemainingPercent` when no short window exists.

### Priming

A weekly-only snapshot with an observed weekly reset is not untouched and is never a primer candidate. Untouched detection requires a reported short window at 0% used plus an absent/unstarted weekly reset, preserving the existing explicit priming safety contract.

### Status and commands

Compact status and `/quota-router list` render an absent short window as `5h n/a`. They render the classified weekly percentage/reset normally. They never relabel a seven-day window as five-hour quota.

Manual routing behavior is unchanged.

## Testing

Strict RED → GREEN tests cover:

1. a primary `604800`-second window becomes weekly-only;
2. a secondary `18000`-second window becomes short regardless of position;
3. complete legacy responses without duration retain positional mapping;
4. unknown explicit durations and duplicate recognized kinds fail safely;
5. a weekly-only candidate is automatically eligible and receives weekly urgency;
6. missing short quota omits the short-headroom veto and explanation field;
7. weekly-only cache expiry, block derivation, and priming are correct;
8. status and list output show `5h n/a` and the real weekly quota;
9. strict v1 state migrates losslessly to v2 and v2 weekly-only state round-trips;
10. normal two-window behavior, replay safety, secret boundaries, and Pi extension loading remain unchanged.

Full lint, typecheck, unit, integration, end-to-end, secret, audit, package, GitHub install, and live Herdr checks are required.

## Rollout

After review and CI:

1. merge the follow-up PR;
2. pin the user-global Pi package to the exact merged `origin/main` commit;
3. reload every idle/done Pi process in place through Herdr;
4. run `/quota-router refresh all` and `/quota-router list`;
5. verify the live primary seven-day windows appear as weekly quota and `5h n/a`;
6. verify at least the unblocked account is automatically eligible;
7. send one controlled turn and confirm it either routes normally or terminates for a real remaining block, never `weekly_window_unknown`;
8. confirm all original Pi PIDs/session paths remain intact.

No credential mutation, cooldown reset, process restart, or fabricated quota value is part of the rollout.
