# Live UX Follow-up Design

**Date:** 2026-07-10

**Status:** Approved by the live-use comment on PR #1 and the explicit instruction to implement every listed requirement

## Outcome

Normal Pi users can deliberately choose how to handle the Codex OAuth URL, see a correct footer immediately after login, discover managed accounts through `/quota-router list`, and understand the command surface from the bare dashboard or `/quota-router help`.

## Authorization handoff

`src/commands/authorization-handoff.ts` owns the URL handoff. It always prints the authorization URL and any provider instructions first, preserving a manual fallback in every environment. It then calls `ctx.ui.select` with three explicit actions:

1. `Open authorization URL in default browser`
2. `Copy authorization URL`
3. `Continue manually (URL shown above)`

Opening uses `node:child_process.spawn` directly with platform arguments (`open`, `rundll32 url.dll,FileProtocolHandler`, or `xdg-open`) and never invokes a shell. Copying uses normal Pi's public `copyToClipboard` export. Selector, launcher, or clipboard failures produce a warning that repeats the URL; they never abort OAuth or hide the manual path.

`performCodexLogin` tracks the asynchronous handoff started by OAuth's synchronous `onAuth` callback and waits for it before completing the command. The launcher and clipboard functions are dependency-injected for deterministic tests.

## Immediate status ownership

`performCodexLogin` returns `{ id, label, message }`. `RouterController.operations.login` adopts the successful account as the current display account before returning. Its next `status()` therefore renders the new label in automatic mode instead of `none · login`.

The `/quota-router login` dispatcher immediately calls `operations.status()` and `ctx.ui.setStatus("quota-router", status)` after login resolves and before the success notification. A failed/cancelled login does not mutate or rerender status.

## Command discovery

The parser accepts `list` and `help` in addition to the existing commands. `list` dispatches to the existing account-list operation. Bare `/quota-router` and `/quota-router help` return the compact status followed by a `QUICK COMMANDS` block.

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
