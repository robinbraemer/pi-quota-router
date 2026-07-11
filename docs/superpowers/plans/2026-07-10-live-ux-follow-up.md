# Live UX Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement every live-use UX requirement from PR #1: explicit authorization handoff, immediate login status, list/help discovery, tests, and merge gates.

**Architecture:** Add one focused URL-handoff module, return structured login state to the controller, and keep status/help rendering in the command boundary. Preserve normal Pi public APIs and inject external effects for deterministic tests.

**Tech Stack:** TypeScript with erasable syntax, normal Pi 0.80.6 public APIs, Bun 1.3.7 and `bun:test`, Biome, tsgo.

## Global Constraints

- Work only on `feat/implement-quota-router` and push only to existing PR #1.
- Use TDD for every behavior change and observe each focused test fail for the intended reason.
- Never invoke a shell to open the authorization URL.
- Display the validated authorization URL for manual selection and every unavailable or failed action.
- Preserve model/thinking identity, credential boundaries, and existing routing guarantees.
- Squash-merge only after implementation review, no-mistakes, push CI, and PR CI are all green.

---

### Task 1: Authorization action selector

**Files:**
- Create: `src/commands/authorization-actions.ts`
- Modify: `src/commands/login.ts`
- Test: `test/integration/login.test.ts`

**Interfaces:**
- Produces: `AuthorizationActions`, `validateAuthorizationUrl(value)`, and `CodexLoginResult`.
- Consumes: `ExtensionCommandContext.ui.select`, `ExtensionCommandContext.ui.notify`, and argument-safe platform processes.

- [ ] **Step 1: Write failing selector tests**

Cover browser selection, copy selection, manual/cancel selection, and failures. Assert manual and failure warnings include the validated URL.

- [ ] **Step 2: Verify red**

Run: `bun test test/integration/login.test.ts`

Expected: failures because the selector and validated action dependencies do not exist.

- [ ] **Step 3: Implement the minimal handoff**

Create the validated action boundary:

```ts
export interface AuthorizationActions {
  open(url: string): Promise<void>;
  copy(url: string): Promise<void>;
}

export function validateAuthorizationUrl(value: string): string;
```

Implement the platform launchers with argument-array `spawn`, keep selector/manual fallback handling in `login.ts`, and make `performCodexLogin` return:

```ts
export interface CodexLoginResult {
  id: string;
  label: string;
  message: string;
}
```

- [ ] **Step 4: Verify green**

Run: `bun test test/integration/login.test.ts`

Expected: all authorization handoff and login tests pass.

### Task 2: Immediate successful-login status

**Files:**
- Modify: `src/router-controller.ts`
- Modify: `src/commands/commands.ts`
- Test: `test/integration/router-controller.test.ts`
- Test: `test/integration/commands.test.ts`

**Interfaces:**
- Consumes: `CodexLoginResult` from Task 1.
- Produces: immediate `ctx.ui.setStatus("quota-router", await operations.status())` after successful login.

- [ ] **Step 1: Write failing controller and dispatcher tests**

Inject a successful OAuth login, assert the controller status contains the new label and `auto`, and assert the command calls `setStatus` after login but before success notification.

- [ ] **Step 2: Verify red**

Run: `bun test test/integration/router-controller.test.ts test/integration/commands.test.ts`

Expected: status remains `none · login` and no command-time `setStatus` call occurs.

- [ ] **Step 3: Implement minimal state/rerender changes**

Add an injectable login function to `RouterControllerOptions`, adopt `result.id/result.label` as display-only state on success without changing successful-route hysteresis, and rerender status inside the login dispatch branch.

- [ ] **Step 4: Verify green**

Run the same focused command and controller tests; expected all pass.

### Task 3: List alias and discoverable dashboard

**Files:**
- Modify: `src/commands/parser.ts`
- Modify: `src/commands/commands.ts`
- Modify: `README.md`
- Test: `test/unit/command-parser.test.ts`
- Test: `test/integration/commands.test.ts`

**Interfaces:**
- Produces: `list` alias, `help` alias, and `formatQuotaRouterDashboard(status: string): string`.

- [ ] **Step 1: Write failing parser/command discovery tests**

Assert `list` maps to accounts, `help` maps to dashboard, and bare/help output includes all prominent and secondary command strings.

- [ ] **Step 2: Verify red**

Run: `bun test test/unit/command-parser.test.ts test/integration/commands.test.ts`

Expected: parser rejects aliases and dashboard lacks quick commands.

- [ ] **Step 3: Implement aliases and portable visual hierarchy**

Add `list` and `help` parser commands. Prefix the six primary commands with `◆` in a `QUICK COMMANDS` block and enumerate secondary commands below them. Update README examples/table.

- [ ] **Step 4: Verify green**

Run the same focused parser/command tests; expected all pass.

### Task 4: Full validation and integration

**Files:**
- Modify only files required by review findings.

**Interfaces:**
- Consumes: all behavior from Tasks 1–3.
- Produces: reviewed, green, squash-merged PR #1.

- [ ] **Step 1: Run the complete local gate**

```bash
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run audit
bun run check:secrets
bun run smoke:install
bun run pack:check
git diff --check
```

- [ ] **Step 2: Commit and run no-mistakes**

Commit only the UX follow-up, then run `no-mistakes axi run --yes --intent <full-live-UX-intent>` and resolve every legitimate finding through the gate.

- [ ] **Step 3: Push only the existing branch and verify current CI**

Push `feat/implement-quota-router`, then require every push and pull-request check on PR #1 to complete successfully.

- [ ] **Step 4: Authorized squash merge**

Use `gh-axi pr merge 1 --squash --delete-branch` only after review and CI are green. Verify PR state is merged and read the exact merge commit SHA from GitHub.
