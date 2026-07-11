# Quota Router Live UX Follow-up Implementation Plan

> **For agentic workers:** Execute inline in this isolated PR worktree. Do not create a new branch or PR, and do not delegate this firstmate dispatch.

**Goal:** Make Codex login handoff explicit and safe, refresh status immediately after login, add a discoverable `list` command with quota state, and turn the dashboard into command-oriented help.

**Architecture:** Keep OAuth credential exchange and persistence unchanged. Add a small authorization-actions boundary that validates the fixed OpenAI authorization endpoint before offering Pi's selector, then invokes browser/clipboard launchers with explicit argv and always retains a manual URL fallback. Keep command routing responsible for immediate footer rendering, while the router controller updates its cached active label/id after persistence and formats list/dashboard data from existing cached state.

**Tech Stack:** TypeScript, Bun test, normal Pi extension APIs, Node `child_process.spawn` without shell execution.

## Global Constraints

- Reuse `feat/implement-quota-router`, PR #1, and normal Pi 0.80.6 public UI APIs.
- Never send provider-controlled text through a shell or command string.
- Only open or copy a validated `https://auth.openai.com/oauth/authorize` URL without embedded credentials.
- The only copied value is that authorization URL; OAuth credentials and account tokens remain inside the existing vault path.
- Browser/clipboard failure is non-destructive and shows the same validated URL for manual use.
- Do not alter routing, priming, reservation, failover, credential-storage, or quota policy behavior.

---

### Task 1: Specify the login handoff and security boundary

**Files:**
- Modify: `test/integration/login.test.ts`

**Interfaces:**
- Exercise `performCodexLogin({ ctx, vault, login, actions })` with injected `open(url)` and `copy(url)` actions.
- Require exact selector labels for open, copy, and manual fallback.

- [x] Add focused tests proving selector display, open dispatch, copy dispatch, cancellation/unavailable/action-failure manual fallback, unsafe URL rejection, and the absence of copied credentials.
- [x] Run `bun test test/integration/login.test.ts` and confirm the new assertions fail because the selector/action boundary does not exist.

### Task 2: Specify command discoverability and immediate status rendering

**Files:**
- Modify: `test/unit/command-parser.test.ts`
- Modify: `test/integration/commands.test.ts`

**Interfaces:**
- Parse `list` as a first-class `QuotaRouterCommand`.
- Dispatch it to `operations.list()`.
- After `operations.login()` succeeds, call `ctx.ui.setStatus("quota-router", await operations.status())` before the handler resolves.
- Dashboard text must put `login`, `list`, `status`, `use auto`, `refresh`, and `prime` on visually distinct command lines.

- [x] Add parser, list-dispatch, status-rerender, and highlighted dashboard assertions.
- [x] Run both focused test files and confirm failures are caused by the missing `list`, rerender, and dashboard help behavior.

### Task 3: Implement argument-safe authorization actions

**Files:**
- Create: `src/commands/authorization-actions.ts`
- Modify: `src/commands/login.ts`

**Interfaces:**
- `AuthorizationActions` exposes `open(url: string): Promise<void>` and `copy(url: string): Promise<void>`.
- `validateAuthorizationUrl(value: string): string` accepts only the fixed HTTPS OpenAI authorization origin/path, rejects usernames/passwords, and returns the canonical URL string.
- Default launchers call `spawn(command, argv, { shell: false, ... })`; clipboard input is written through stdin.

- [x] Implement URL validation and platform launchers with explicit argv.
- [x] Start the async selector from the synchronous OAuth `onAuth` callback, await it before vault persistence completes, and convert every unavailable/failure/cancel path into a warning containing only the validated manual URL.
- [x] Run `bun test test/integration/login.test.ts` until green, then refactor only while it remains green.

### Task 4: Implement list, dashboard help, and post-login status

**Files:**
- Create: `src/commands/dashboard.ts`
- Modify: `src/commands/parser.ts`
- Modify: `src/commands/commands.ts`
- Modify: `src/router-controller.ts`

**Interfaces:**
- `formatDashboard(status: string): string` returns compact status plus highlighted command rows.
- `QuotaRouterOperations.list()` returns the existing managed-account view enriched from cached usage when available.
- Login updates `currentAccountId/currentLabel` only after vault persistence succeeds.

- [x] Implement the parser and dispatcher additions.
- [x] Format dashboard help using multiline Pi notification text with a visible `AVAILABLE COMMANDS` heading and `>`-prefixed command rows.
- [x] Reuse one account-list formatter for `accounts` and `list`, adding cached 5-hour/weekly remaining state or `quota unknown` without network work.
- [x] Update the controller's current account only after successful login and have the command handler rerender the footer in the same awaited lifecycle.
- [x] Run the focused parser, command, controller, and login tests until green.

### Task 5: Document and verify the security-focused UX change

**Files:**
- Modify: `README.md`
- Modify: `docs/security.md`

- [x] Document the `list` command, selector choices, immediate status update, strict authorization URL validation, argv-only launchers, and manual fallback.
- [x] Run `bun run check`, `bun run audit`, `bun run check:secrets`, `bun run smoke:install`, and `bun run pack:check`; inspect complete output and fix only failures caused by this change.
- [x] Review `git diff --check`, `git diff`, and `git status --short`; confirm the diff stays within the UX/security follow-up.
- [x] Commit all task files on `feat/implement-quota-router` with a focused message, then report `done` to firstmate without pushing or starting no-mistakes validation.
