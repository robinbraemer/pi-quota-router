# Duration-Aware Codex Usage Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correctly route and display Codex accounts whose provider response reports a duration-tagged weekly window without a five-hour window.

**Architecture:** Normalize provider windows into optional semantic short/weekly fields using explicit duration metadata before positional fallback. Migrate non-secret runtime state from strict v1 snapshots with required short quota to strict v2 snapshots with optional short quota, then make every consumer operate only on reported windows.

**Tech Stack:** TypeScript, Bun 1.3.7+, Zod 4, Biome, normal Pi public extension APIs.

## Global Constraints

- Recognize `18000` seconds as five-hour and `604800` seconds as weekly.
- Accept both HTTP `limit_window_seconds` and RPC-compatible `windowDurationMins` duration fields.
- Use legacy primary→short and secondary→weekly mapping only when duration metadata is absent.
- Never infer kind from reset distance, duplicate a weekly window as short, or fabricate percentages/resets.
- Weekly quota/reset remains required for automatic urgency routing; short headroom applies only when a short window is reported.
- Vault/config stay version 1; runtime state migrates strictly from version 1 to version 2 without credential changes.
- No process restart, credential mutation, cooldown reset, or duplicate repair agent.

---

### Task 1: Normalize windows by explicit duration

**Files:**
- Modify: `src/types.ts`
- Modify: `src/usage/codex-usage.ts`
- Modify: `test/fixtures/usage-responses.ts`
- Modify: `test/unit/codex-usage.test.ts`

**Interfaces:**
- Consumes: provider `rate_limit.primary_window` / `secondary_window` objects.
- Produces: `UsageSnapshot` with `shortWindow?: UsageWindow` and `weeklyWindow?: UsageWindow`.

- [ ] **Step 1: Add failing parser regressions.** Add a `weeklyOnlyPrimaryUsageResponse` whose primary has `used_percent: 3`, `reset_at`, and `limit_window_seconds: 604800`. Assert it yields no `shortWindow` and one `weeklyWindow`. Add reversed recognized durations and camel-case duration coverage. Add explicit unknown-duration and duplicate-weekly inputs that throw `CodexUsageParseError`. Keep a durationless complete response asserting legacy positional behavior.

```ts
expect(parseCodexUsage(weeklyOnlyPrimaryUsageResponse, NOW, "codex-a")).toEqual({
  accountId: "codex-a",
  observedAt: NOW,
  weeklyWindow: { usedPercent: 3, resetsAt: WEEKLY_RESET },
  stale: false,
  planType: "pro",
});
expect(() => parseCodexUsage(unknownDurationResponse, NOW, "codex-a")).toThrow(
  CodexUsageParseError,
);
```

- [ ] **Step 2: Run RED.**

Run: `bun test test/unit/codex-usage.test.ts`

Expected: weekly-only and reversed-duration assertions fail because primary is still hard-coded as short; unknown duration does not fail for the intended reason.

- [ ] **Step 3: Make the snapshot short window optional and implement minimal classification.** Parse each window once with its optional duration. Accept the snake-case HTTP names and their camel-case RPC equivalents for used percentage, reset, and duration. A recognized duration overrides position. A missing duration uses the supplied positional fallback. Reject unknown explicit durations, duplicate semantic kinds, and no usable windows.

```ts
const SHORT_WINDOW_SECONDS = 18_000;
const WEEKLY_WINDOW_SECONDS = 604_800;
type WindowKind = "short" | "weekly";

interface ParsedWindow {
  kind: WindowKind;
  value: UsageWindow;
}

function classifyWindow(value: Record<string, unknown>, fallback: WindowKind): WindowKind {
  const seconds = durationSeconds(value);
  if (seconds === undefined) return fallback;
  if (seconds === SHORT_WINDOW_SECONDS) return "short";
  if (seconds === WEEKLY_WINDOW_SECONDS) return "weekly";
  throw new CodexUsageParseError();
}
```

- [ ] **Step 4: Run GREEN and typecheck the local boundary.**

Run: `bun test test/unit/codex-usage.test.ts && bun run typecheck`

Expected: parser tests pass; typecheck now lists only downstream required-short consumers to update in Tasks 2–3.

- [ ] **Step 5: Commit the parser boundary.**

```bash
git add src/types.ts src/usage/codex-usage.ts test/fixtures/usage-responses.ts test/unit/codex-usage.test.ts
git commit -m "fix: classify Codex quota windows by duration"
```

### Task 2: Migrate runtime state to weekly-only snapshots

**Files:**
- Modify: `src/storage/schemas.ts`
- Modify: `test/unit/storage-schemas.test.ts`

**Interfaces:**
- Consumes: strict v1 runtime state and new `UsageSnapshot` shape.
- Produces: `RuntimeStateFileSchema` output normalized to `version: 2` and `defaultRuntimeState.version === 2`.

- [ ] **Step 1: Add failing state migration tests.** Assert strict v1 state parses and becomes version 2 without losing data. Assert strict v2 weekly-only snapshots round-trip. Assert v2 rejects unknown fields and a snapshot with neither window.

```ts
const migrated = RuntimeStateFileSchema.parse(frozenOldV1State);
expect(migrated.version).toBe(2);
expect(
  RuntimeStateFileSchema.parse({
    ...defaultRuntimeState,
    usageSnapshots: [weeklyOnlySnapshot],
  }).usageSnapshots[0]?.shortWindow,
).toBeUndefined();
```

- [ ] **Step 2: Run RED.**

Run: `bun test test/unit/storage-schemas.test.ts`

Expected: version-two and weekly-only fixtures fail against the v1 required-short schema.

- [ ] **Step 3: Implement explicit v1→v2 normalization.** Keep a private strict v1 snapshot/state schema, add a strict v2 snapshot with optional windows plus a refinement requiring at least one, and export a union transformed to v2.

```ts
const UsageSnapshotV2Schema = UsageSnapshotBaseSchema.extend({
  shortWindow: UsageWindowSchema.optional(),
  weeklyWindow: UsageWindowSchema.optional(),
}).refine((snapshot) => snapshot.shortWindow || snapshot.weeklyWindow);

export const RuntimeStateFileSchema = z
  .union([RuntimeStateFileV1Schema, RuntimeStateFileV2Schema])
  .transform((state): RuntimeStateFileV2 =>
    state.version === 2 ? state : { ...state, version: 2 },
  );
```

- [ ] **Step 4: Run GREEN.**

Run: `bun test test/unit/storage-schemas.test.ts && bun run typecheck`

Expected: state tests pass; remaining type errors are downstream consumers only.

- [ ] **Step 5: Commit migration.**

```bash
git add src/storage/schemas.ts test/unit/storage-schemas.test.ts
git commit -m "feat: migrate runtime state for optional short quota"
```

### Task 3: Make every consumer honor reported windows

**Files:**
- Modify: `src/routing/selection-policy.ts`
- Modify: `src/usage/usage-service.ts`
- Modify: `src/recovery/recovery-state.ts`
- Modify: `src/priming/priming-controller.ts`
- Modify: `src/status/status-controller.ts`
- Modify: `src/router-controller.ts`
- Modify: `test/fixtures/candidates.ts`
- Modify: `test/unit/selection-policy.test.ts`
- Modify: `test/unit/usage-service.test.ts`
- Modify: `test/unit/recovery-state.test.ts`
- Modify: `test/unit/priming-controller.test.ts`
- Modify: `test/integration/status.test.ts`
- Modify: `test/integration/router-controller.test.ts`
- Modify: `test/e2e/router-guarantees.test.ts`

**Interfaces:**
- Consumes: optional `shortWindow` and required-for-auto `weeklyWindow`.
- Produces: honest selection, cache, recovery, priming, status, and list behavior.

- [ ] **Step 1: Add failing policy/status regressions.** A weekly-only candidate above weekly headroom must be eligible, omit `shortWindowRemainingPercent`, and rank by weekly urgency. Compact status and account list must say `5h n/a` and show the weekly percentage/reset.

```ts
expect(selectAccount(input).accountId).toBe("weekly-only");
expect(explanation.shortWindowRemainingPercent).toBeUndefined();
expect(formatCompactStatus(view)).toContain("5h n/a · 7d 97%/7d");
```

- [ ] **Step 2: Add failing cache/recovery/priming regressions.** A weekly-only cache stays fresh until its weekly reset, an exhausted weekly-only snapshot derives the weekly block, and a weekly-only snapshot with an observed reset is never untouched/primeable.

- [ ] **Step 3: Run RED.**

Run:

```bash
bun test test/unit/selection-policy.test.ts test/unit/usage-service.test.ts test/unit/recovery-state.test.ts test/unit/priming-controller.test.ts test/integration/status.test.ts test/integration/router-controller.test.ts
```

Expected: required-short dereferences fail or weekly-only behavior is incorrect.

- [ ] **Step 4: Implement minimal optional-window handling.** Use neutral `shortRemaining = 100` only internally for tie ordering when absent, but omit it from explanations and never apply the short floor. Iterate `[usage.shortWindow, usage.weeklyWindow]` only after filtering. Require a reported short window for untouched priming. Render `5h n/a` in both status surfaces.

```ts
const short = candidate.usage.shortWindow;
const shortRemaining = short
  ? Math.max(0, 100 - short.usedPercent - penalty)
  : undefined;
if (
  shortRemaining !== undefined &&
  shortRemaining < input.config.headroom.shortWindowMinimumPercent
) {
  return shortHeadroomRejection;
}
```

- [ ] **Step 5: Run GREEN and the end-to-end guarantee.**

Run:

```bash
bun test test/unit/selection-policy.test.ts test/unit/usage-service.test.ts test/unit/recovery-state.test.ts test/unit/priming-controller.test.ts test/integration/status.test.ts test/integration/router-controller.test.ts test/e2e/router-guarantees.test.ts
bun run typecheck
```

Expected: all focused tests and typecheck pass.

- [ ] **Step 6: Commit consumer behavior.**

```bash
git add src test/fixtures test/unit test/integration test/e2e
git commit -m "fix: route accounts with weekly-only quota"
```

### Task 4: Document, validate, publish, and roll out

**Files:**
- Modify: `README.md`
- Modify: `docs/policy.md`
- Modify: `docs/troubleshooting.md`
- Modify: `docs/superpowers/specs/2026-07-10-pi-quota-router-design.md`

**Interfaces:**
- Consumes: completed duration-aware behavior.
- Produces: operator guidance, reviewed PR, merged commit, and verified global Pi rollout.

- [ ] **Step 1: Update documentation.** Document duration-based classification, weekly-only eligibility, `5h n/a`, state v2 migration/rollback consequence, and troubleshooting for unsupported explicit durations.

- [ ] **Step 2: Run full local gates.**

```bash
bun run check
bun run check:secrets
bun run audit
bun run pack:check
git diff --check
```

Expected: all pass with zero findings/failures.

- [ ] **Step 3: Commit documentation.**

```bash
git add README.md docs
git commit -m "docs: explain duration-aware quota windows"
```

- [ ] **Step 4: Run no-mistakes with the full user intent.** Drive every gate; authorize mechanical fixes, preserve pipeline commits, and stop only for a genuinely new product decision.

- [ ] **Step 5: Merge after green CI.** Set `PR_NUMBER` from the PR number returned by no-mistakes, run `gh-axi pr merge "$PR_NUMBER" --squash --delete-branch`, verify the PR is merged, fetch `origin/main`, and set `MERGED_SHA=$(git rev-parse origin/main)`.

- [ ] **Step 6: Verify the published GitHub install.** Run `PI_QUOTA_ROUTER_GIT_REVISION="$MERGED_SHA" bun run smoke:install`.

- [ ] **Step 7: Install globally and reload all Pi processes.** Run `pi install "git:git@github.com:robinbraemer/pi-quota-router@$MERGED_SHA"`, capture Herdr PIDs/session paths, reload idle/done panes in place, and run `/quota-router verify` everywhere.

- [ ] **Step 8: Prove the live fix.** Run `/quota-router refresh all` and `/quota-router list`; confirm `5h n/a`, real seven-day quota, and at least one automatic eligible candidate. Send one controlled turn and require normal routing or a real non-window block—not `weekly_window_unknown`. Confirm all PIDs/session paths remain unchanged.
