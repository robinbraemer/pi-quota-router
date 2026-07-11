# Live UX Follow-up Design

**Date:** 2026-07-10

**Status:** Implemented

## Outcome

Normal Pi users can deliberately choose how to handle the Codex OAuth URL, see a correct footer immediately after login, discover managed accounts through `/quota-router list`, and understand the command surface from the bare dashboard or `/quota-router help`.

## Authorization handoff

`src/commands/authorization-actions.ts` validates the fixed OpenAI authorization endpoint and owns the argument-safe browser and clipboard launchers. `src/commands/login.ts` calls `ctx.ui.select` with three explicit actions:

1. `Open authorization URL in default browser`
2. `Copy authorization URL`
3. `Show authorization URL for manual use`

Opening uses `node:child_process.spawn` directly with platform arguments (`open`, `rundll32 url.dll,FileProtocolHandler`, or `xdg-open`) and never invokes a shell. Copying writes only the validated URL to a platform clipboard process over stdin. Manual selection and selector, launcher, or clipboard failures produce a warning that includes the validated URL; those action failures never abort OAuth or hide the manual path.

`performCodexLogin` starts the asynchronous handoff from OAuth's synchronous `onAuth` callback. Manual-code fallback waits for that choice, while a successful browser callback aborts an outstanding selector or prompt. The action settles before vault persistence, so an unexpected authorization URL prevents credentials from being saved. The launcher and clipboard functions are dependency-injected for deterministic tests.

## Immediate status ownership

`performCodexLogin` returns `{ id, label, message }`. `RouterController.operations.login` adopts the successful account as the current display account before returning. Its next `status()` therefore renders the new label in automatic mode instead of `none · login`. Display ownership is separate from automatic-routing hysteresis, which changes only after a routed request completes successfully.

The `/quota-router login` dispatcher immediately calls `operations.status()` and `ctx.ui.setStatus("quota-router", status)` after login resolves and before the success notification. A failed/cancelled login does not mutate or rerender status.

## Command discovery

The parser accepts `list` and `help` in addition to the existing commands. `list` has a first-class operation, while `accounts` uses the same cached-quota formatter as a compatibility alias. Bare `/quota-router` and `/quota-router help` return the compact status followed by a `QUICK COMMANDS` block.

The quick block uses prominent `◆` markers for the live-use commands:

- `/quota-router login [label]`
- `/quota-router list`
- `/quota-router status`
- `/quota-router use auto`
- `/quota-router refresh [account|all]`
- `/quota-router prime [account|all]`

It also enumerates `use`, `policy`, `reset`, `verify`, `path`, and `log`, so no supported command remains hidden. The text is portable across interactive, print, and RPC modes and does not depend on ANSI color support.

## Tests and documentation

- Unit/integration tests cover each selector action, cancellation/manual fallback, launcher/copy failure fallback, and the structured login result.
- Command tests cover `list`, `help`, quick-command enumeration, and immediate status rerender ordering.
- Router-controller integration proves a successful injected login changes status from `none · login` to the account label in `auto` mode.
- Parser tests cover both aliases and the discoverability error text.
- README command/login documentation matches the executable behavior.

The full Bun check, audit, secret scan, GitHub install smoke, package check, no-mistakes review, push CI, and PR CI must pass before the authorized squash merge.
