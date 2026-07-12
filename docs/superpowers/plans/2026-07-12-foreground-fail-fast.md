# Foreground Quota Fail-Fast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every foreground routed request terminate immediately with an actionable sanitized error when fresh selection finds no eligible Codex account.

**Architecture:** Preserve the existing fresh usage evaluation and replay-safe account rotation. Remove foreground recovery waiting from `RoutedStreamDependencies`; unavailable selection becomes a typed terminal route error. Keep the version-one `maxRecoveryWaitMs` field accepted only for strict persisted-config and rollback compatibility.

**Tech Stack:** TypeScript, Bun 1.3.7, Pi public extension APIs, Bun test, Biome, tsgo.

## Global Constraints

- Do not restart Pi, mutate credentials, reset cooldowns, or replay a request after visible output.
- Keep all terminal diagnostics free of account ids, labels, tokens, raw provider payloads, and persisted state.
- Preserve version-one strict config compatibility, including `maxRecoveryWaitMs`.
- Preserve pre-output rotation, post-output non-replay, reservation ownership, and controller-local affinity.
- Use strict RED → GREEN TDD and commit only focused changes.

---

### Task 1: Terminate unavailable routed streams immediately

**Files:**
- Modify: `test/integration/routed-stream.test.ts:37-363`
- Modify: `src/stream/routed-stream.ts:36-114,319-332`

**Interfaces:**
- Consumes: `RouteSelection` from `selectAndReserve` with `kind`, `reason`, and existing compatibility metadata.
- Produces: `RouteUnavailableError`-backed terminal events; `RoutedStreamDependencies` without `recoveryDeadline` or `waitForRecovery`.

- [ ] **Step 1: Write failing stream tests.** Remove the recovery functions from the test dependency fixture. Replace the recovery-deadline test with these behaviors:

```typescript
test("fails immediately when every account is temporarily unavailable", async () => {
  const setup = dependencies(["a"], () => eventStream(successfulText()));
  setup.value.selectAndReserve = async () => ({
    kind: "unavailable",
    reason: "no_eligible_accounts",
    recoverableAccountIds: ["a"],
    knownAccountIds: ["a"],
  });

  const events = await collect(createRoutedStream(setup.value)(model, context));

  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("error");
  if (events[0]?.type === "error") {
    expect(events[0].error.errorMessage).toBe(
      "No Codex account is currently eligible; quota, usage data, or account health must recover before retrying",
    );
  }
});

test("reports an unavailable manual account distinctly", async () => {
  const setup = dependencies([], () => eventStream(successfulText()));
  setup.value.selectAndReserve = async () => ({
    kind: "unavailable",
    reason: "manual_account_unavailable",
    recoverableAccountIds: [],
    knownAccountIds: ["a"],
  });

  const events = await collect(createRoutedStream(setup.value)(model, context));
  const terminal = events[0];
  expect(terminal?.type).toBe("error");
  if (terminal?.type === "error") {
    expect(terminal.error.errorMessage).toBe("The selected Codex account is currently unavailable");
  }
});
```

- [ ] **Step 2: Run the focused test and verify RED.**

Run: `bun test test/integration/routed-stream.test.ts`

Expected: compile failure because the fixture omits required recovery dependencies, and/or assertion failure because recoverable unavailability waits instead of producing the selected message.

- [ ] **Step 3: Implement the minimal stream change.** Remove `recoveryDeadline` and `waitForRecovery` from `RoutedStreamDependencies`, remove the recovery deadline local, and replace the unavailable branch with:

```typescript
if (selection.kind === "unavailable") {
  lastFailure = new RouteUnavailableError(selection.reason);
  break;
}
```

Use a typed error whose constructor maps only approved internal reasons:

```typescript
class RouteUnavailableError extends Error {
  override readonly name = "RouteUnavailableError";

  constructor(reason: string) {
    super(
      reason === "no_eligible_accounts"
        ? "No Codex account is currently eligible; quota, usage data, or account health must recover before retrying"
        : reason === "manual_account_unavailable"
          ? "The selected Codex account is currently unavailable"
          : `No Codex account is available: ${reason}`,
    );
  }
}
```

Add `RouteUnavailableError` to the sanitizer's typed-error allowlist. Remove unused recovery-error imports only after the foreground dependency is gone.

- [ ] **Step 4: Run focused tests and verify GREEN.**

Run: `bun test test/integration/routed-stream.test.ts`

Expected: all routed-stream tests pass; pre-output rotation and post-output non-replay remain green.

- [ ] **Step 5: Commit the routed-stream behavior.**

```bash
git add src/stream/routed-stream.ts test/integration/routed-stream.test.ts
git commit -m "fix: fail fast when no Codex account is eligible"
```

### Task 2: Remove foreground wait wiring while preserving v1 config

**Files:**
- Modify: `test/integration/router-controller.test.ts:1630-1721`
- Modify: `src/router-controller.ts:17-24,253-388`
- Verify: `src/storage/schemas.ts:119-144`
- Verify: `test/unit/storage-schemas.test.ts:21-36`

**Interfaces:**
- Consumes: updated `RoutedStreamDependencies` from Task 1.
- Produces: controller foreground routing with no recovery timer; unchanged strict v1 config schema.

- [ ] **Step 1: Write the failing controller regression.** Replace `uses the configured maximum recovery wait` with a test named `ignores the legacy recovery wait and fails a blocked foreground route promptly`. Keep `maxRecoveryWaitMs: 21_600_000`, install a future quota block, collect the stream, and assert the exact `no_eligible_accounts` message. Replace `waits for recovery after every account fails in one request` with `fails immediately after every account fails before output`, keep `maxRotationAttempts: 3`, and assert two provider calls followed by the same exact terminal message without setting the recovery wait to zero.

- [ ] **Step 2: Run the focused controller test and verify RED.**

Run: `bun test test/integration/router-controller.test.ts`

Expected: the blocked-route test does not terminate promptly under the current six-hour foreground wait contract. Abort the focused test if necessary after confirming it is waiting in `waitForRecovery`; do not change production code before observing RED.

- [ ] **Step 3: Remove controller recovery wiring.** Remove the production import of `waitForRecovery` and delete these `createRoutedStream` dependency properties:

```typescript
recoveryDeadline: () => clock() + cachedConfig.maxRecoveryWaitMs,
waitForRecovery: (accountIds, knownAccountIds, deadline, signal) =>
  waitForRecovery({
    stateStore,
    clock,
    accountIds,
    knownAccountIds,
    listAccountIds: async () => (await vault.list()).map((account) => account.id),
    deadline,
    ...(signal ? { signal } : {}),
  }),
```

Do not remove `maxRecoveryWaitMs` from `RouterConfig`, `defaultConfig`, or `RouterConfigSchema`.

- [ ] **Step 4: Run controller and v1 compatibility tests and verify GREEN.**

Run: `bun test test/integration/router-controller.test.ts test/unit/storage-schemas.test.ts test/unit/config.test.ts`

Expected: all pass, including frozen version-one config compatibility.

- [ ] **Step 5: Run the recovery helper tests unchanged.**

Run: `bun test test/unit/wait-for-recovery.test.ts`

Expected: all pass; the helper remains valid but is no longer used by foreground streams.

- [ ] **Step 6: Commit controller wiring.**

```bash
git add src/router-controller.ts test/integration/router-controller.test.ts
git commit -m "fix: remove foreground quota recovery waits"
```

### Task 3: Document compatibility and validate the release surface

**Files:**
- Modify: `README.md`
- Modify: `docs/troubleshooting.md`
- Modify: `docs/superpowers/specs/2026-07-10-pi-quota-router-design.md`
- Modify: `docs/superpowers/plans/2026-07-10-pi-quota-router.md`

**Interfaces:**
- Consumes: fail-fast foreground behavior from Tasks 1–2.
- Produces: operator documentation matching the shipped contract.

- [ ] **Step 1: Update documentation.** State that fresh selection and safe pre-output rotation occur within one request, but unavailable selection terminates immediately. Mark `maxRecoveryWaitMs` as a reserved v1 compatibility field that no longer affects foreground requests. Replace troubleshooting guidance for `RecoveryWaitTimeoutError` with the new actionable terminal selection errors while retaining helper provenance where necessary.

- [ ] **Step 2: Verify documentation consistency.**

Run:

```bash
rg -n "six hours|waits for recovery|RecoveryWaitTimeoutError|maxRecoveryWaitMs" README.md docs src test
git diff --check
```

Expected: no documentation claims that foreground requests wait for quota; remaining `maxRecoveryWaitMs` references explicitly describe compatibility or standalone helper tests.

- [ ] **Step 3: Run all local release gates.**

```bash
bun run check
bun run check:secrets
bun run audit
bun run pack:check
bun run smoke:install
git diff --check
```

Expected: 0 test failures, 0 lint/type errors, 0 high-severity production advisories, no secret findings, expected package contents, and successful isolated Pi loading.

- [ ] **Step 4: Commit documentation.**

```bash
git add README.md docs/troubleshooting.md docs/superpowers/specs/2026-07-10-pi-quota-router-design.md docs/superpowers/plans/2026-07-10-pi-quota-router.md
git commit -m "docs: document foreground quota fail-fast behavior"
```

- [ ] **Step 5: Run no-mistakes with the original intent.** Invoke `no-mistakes axi run --intent` with the production Herdr evidence, immediate-error requirement, compatibility constraint, and no-restart rollout requirement. Resolve only `auto-fix` findings autonomously; escalate any `ask-user` finding.

- [ ] **Step 6: Deploy the exact validated commit and verify with Herdr.** Pin Pi settings to the exact branch head, refresh that exact Git package, abort only the already-pending `wA:p18` response, reload in the same Pi process, and verify the next no-eligible turn emits a terminal error instead of remaining working. Confirm the Pi PID and session path are unchanged.
