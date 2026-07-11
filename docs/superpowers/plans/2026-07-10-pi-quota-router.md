# Pi Quota Router Implementation Plan

> Required sub-skill: use superpowers:test-driven-development for every implementation task and superpowers:verification-before-completion before claiming a task complete.

**Goal:** Build and publish a normal-Pi extension that routes an unchanged Codex model across equivalent ChatGPT OAuth accounts using fresh quota, safe explicit priming, urgency-based draining, cross-process coordination, and replay-safe failover.

**Architecture:** Override Pi's built-in openai-codex provider with a thin routed stream. Keep selection, usage, persistence, reservations, priming, and failure classification in independently tested modules. Reuse only public normal-Pi exports. Store multi-account credentials in a private extension vault and non-secret coordination data in a separate state file.

**Tech stack:** TypeScript with erasable syntax; Bun 1.3.7+ for installs, scripts, and bun:test; Node.js 22.19+ runtime compatibility; normal Pi 0.80.6 public APIs; Zod 4.3.6; proper-lockfile 4.1.2; Biome; tsgo.

## Global constraints

- Implement against normal Pi only. Do not add OMP compatibility or provider aliases.
- Keep provider and model identity openai-codex; never change the user's chosen model or thinking level.
- Use Bun for all repository workflows. Production code must not import bun:* or use Bun-only globals.
- Use only public package exports from @earendil-works/pi-ai and @earendil-works/pi-coding-agent.
- Never read or mutate Pi's auth.json.
- Never log, persist outside the vault, or expose access tokens, refresh tokens, JWT payloads, or raw account ids.
- A synthetic primer is allowed only after both interactive confirmations for that one invocation; the command must not persist automatic-priming authorization.
- A stream retry is allowed only before text, thinking, or tool-call content begins.
- Every state mutation must be atomic under a cross-process lock.
- Commit after each task only when the named tests and checks pass.

## Task 1: Scaffold the Bun package and public contracts

**Files**

- Create: package.json
- Create: tsconfig.json
- Create: biome.json
- Create: src/index.ts
- Create: src/types.ts
- Create: src/config.ts
- Create: test/unit/config.test.ts
- Modify: .gitignore

**Step 1: Write the failing config test**

The first test fixes safe defaults and proves that both priming confirmations are required.

    import { describe, expect, test } from "bun:test";
    import { defaultConfig, isPrimingAuthorized } from "../../src/config.ts";

    describe("router config", () => {
      test("ships conservative routing defaults", () => {
        expect(defaultConfig.usageFreshnessMs).toBe(300_000);
        expect(defaultConfig.maxRotationAttempts).toBe(5);
        expect(defaultConfig.headroom.shortWindowMinimumPercent).toBe(10);
        expect(defaultConfig.headroom.weeklyMinimumPercent).toBe(3);
      });

      test("requires enablement and rolling-window confirmation", () => {
        expect(isPrimingAuthorized(defaultConfig)).toBe(false);
        expect(isPrimingAuthorized({
          ...defaultConfig,
          priming: {
            ...defaultConfig.priming,
            enabled: true,
            confirmedFirstUseRollingWindow: true,
          },
        })).toBe(true);
      });
    });

**Step 2: Run the test and confirm the red state**

Run: bun test test/unit/config.test.ts

Expected: failure because src/config.ts does not exist.

**Step 3: Add package metadata and exact scripts**

package.json must contain:

    {
      "name": "@robinbraemer/pi-quota-router",
      "version": "0.1.0",
      "description": "Quota-aware multi-account routing for normal Pi",
      "type": "module",
      "main": "./src/index.ts",
      "packageManager": "bun@1.3.7",
      "files": ["src", "README.md", "LICENSE"],
      "engines": { "node": ">=22.19.0" },
      "scripts": {
        "test": "bun test",
        "lint": "biome check .",
        "typecheck": "tsgo --noEmit",
        "check": "bun run lint && bun run typecheck && bun test",
        "pack:check": "bun pm pack --dry-run --ignore-scripts"
      },
      "peerDependencies": {
        "@earendil-works/pi-ai": "^0.80.6",
        "@earendil-works/pi-coding-agent": "^0.80.6",
        "@earendil-works/pi-tui": "^0.80.6"
      },
      "dependencies": {
        "proper-lockfile": "4.1.2",
        "zod": "4.3.6"
      },
      "devDependencies": {
        "@biomejs/biome": "2.5.3",
        "@earendil-works/pi-ai": "0.80.6",
        "@earendil-works/pi-coding-agent": "0.80.6",
        "@earendil-works/pi-tui": "0.80.6",
        "@types/bun": "1.3.14",
        "@types/node": "24.12.4",
        "@types/proper-lockfile": "4.1.4",
        "@typescript/native-preview": "7.0.0-dev.20260707.2"
      },
      "pi": { "extensions": ["./src/index.ts"] }
    }

These versions were resolved from the package registry on 2026-07-10. Keep runtime dependency pins exact.

**Step 4: Add shared types and defaults**

src/types.ts defines RouterConfig, ManagedCodexAccount, UsageWindow, UsageSnapshot, Candidate, SelectionDecision, Reservation, AccountBlock, and credential-free RoutingEvent. src/config.ts exports:

    export const defaultConfig: RouterConfig = {
      version: 1,
      enabled: true,
      usageFreshnessMs: 300_000,
      maxRotationAttempts: 5,
      maxRecoveryWaitMs: 21_600_000,
      reservationTtlMs: 120_000,
      scoreHysteresisRatio: 0.1,
      headroom: {
        shortWindowMinimumPercent: 10,
        weeklyMinimumPercent: 3,
      },
      priming: {
        enabled: false,
        confirmedFirstUseRollingWindow: false,
        maximumPerSweep: 1,
        retryCooldownMs: 3_600_000,
      },
    };

    export function isPrimingAuthorized(config: RouterConfig): boolean {
      return config.priming.enabled &&
        config.priming.confirmedFirstUseRollingWindow;
    }

src/index.ts re-exports the extension default from src/extension.ts once that file exists. Until Task 10, it exports only public types so typecheck stays green.

**Step 5: Install and verify**

Run:

    bun install --ignore-scripts
    bun test test/unit/config.test.ts
    bun run typecheck
    bun run lint

Expected: all pass and bun.lock is created.

**Step 6: Commit**

    git add package.json bun.lock tsconfig.json biome.json src/index.ts src/types.ts src/config.ts test/unit/config.test.ts .gitignore
    git commit -m "chore: scaffold bun extension package"

## Task 2: Implement locked atomic JSON persistence

**Files**

- Create: src/storage/atomic-json-store.ts
- Create: src/storage/paths.ts
- Create: src/storage/schemas.ts
- Create: test/unit/atomic-json-store.test.ts
- Create: test/fixtures/storage.ts

**Step 1: Write failing permission, atomicity, and validation tests**

Use a temporary directory and dependency-injected fault hook. Cover:

- directory mode 0700;
- file mode 0600;
- write-temp, fsync, rename, directory-fsync ordering;
- an exception before rename leaves the old primary intact;
- invalid primary data returns a typed validation error;
- two writers serialize and preserve both updates;
- abandoned temp files never replace a valid primary.

The public contract is:

    export interface AtomicJsonStore<T> {
      read(): Promise<T>;
      update(mutator: (current: T) => T | Promise<T>): Promise<T>;
      inspect(): Promise<StoreInspection>;
    }

    export function createAtomicJsonStore<T>(options: {
      path: string;
      schema: z.ZodType<T>;
      createDefault: () => T;
      lockTimeoutMs?: number;
    }): AtomicJsonStore<T>;

**Step 2: Confirm the red state**

Run: bun test test/unit/atomic-json-store.test.ts

Expected: module-not-found failure.

**Step 3: Implement the minimal secure store**

Use node:fs/promises only. Create the parent with recursive mkdir then chmod 0700. For writes:

1. acquire proper-lockfile on a stable sibling lock target;
2. reload and validate after locking;
3. write JSON plus newline to a random same-directory temp file opened with mode 0600 and wx;
4. sync and close the temp handle;
5. rename over the destination;
6. chmod destination 0600;
7. sync the parent directory where supported;
8. release the lock in finally.

Lock acquisition must use bounded retries and return StoreLockTimeoutError rather than writing without a lock.

**Step 4: Add the three persisted schemas**

src/storage/schemas.ts exports strict Zod schemas for:

- AccountVaultFile version 1;
- RouterConfig version 1;
- RuntimeStateFile version 1.

Unknown keys fail validation. Secrets are accepted only by AccountVaultFileSchema.

**Step 5: Verify**

Run:

    bun test test/unit/atomic-json-store.test.ts
    bun run typecheck
    bun run lint

Expected: all pass.

**Step 6: Commit**

    git add src/storage test/unit/atomic-json-store.test.ts test/fixtures/storage.ts
    git commit -m "feat: add locked atomic persistence"

## Task 3: Build the account vault and OAuth lifecycle

**Files**

- Create: src/accounts/account-vault.ts
- Create: src/accounts/account-identity.ts
- Create: src/accounts/oauth-client.ts
- Create: test/unit/account-vault.test.ts
- Create: test/unit/account-identity.test.ts
- Create: test/fixtures/oauth.ts

**Step 1: Write failing identity and refresh tests**

Cover:

- decode the Codex account id from a token without retaining decoded claims;
- derive codex- plus a truncated SHA-256 identity;
- reject a token missing account_id;
- duplicate accountId login updates the same record;
- refresh five minutes before expiry;
- concurrent in-process refresh calls invoke OAuth once;
- cross-process refresh lock reloads and reuses a peer's newer token;
- invalid_grant marks needsReauth only if the rejected credential is still current;
- a network error applies a transient result without invalidation;
- thrown messages never contain supplied tokens.

AccountVault exposes:

    export interface AccountVault {
      list(): Promise<ReadonlyArray<ManagedCodexAccountSummary>>;
      addFromOAuth(label: string, credentials: OAuthCredentials): Promise<string>;
      getFreshCredential(id: string, signal?: AbortSignal): Promise<FreshCredential>;
      remove(id: string): Promise<void>;
      rename(id: string, label: string): Promise<void>;
      markNeedsReauth(id: string, reason: AuthInvalidationReason): Promise<void>;
    }

**Step 2: Confirm the red state**

Run: bun test test/unit/account-identity.test.ts test/unit/account-vault.test.ts

Expected: module-not-found failures.

**Step 3: Implement OAuth adapter**

Import refreshOpenAICodexToken and the OAuth credential type from @earendil-works/pi-ai/oauth. Keep browser login orchestration out of the vault; the command layer supplies completed credentials.

    export interface CodexOAuthClient {
      refresh(refreshToken: string): Promise<OAuthCredentials>;
    }

Inject this interface in tests. Use an account-specific proper-lockfile target, then reload the vault after acquiring it.

**Step 4: Implement deduplication and safe labels**

Normalize labels to printable single-line text, cap at 80 code points, and default to Account plus the stable suffix. Never use email or token claims as the persistent id.

**Step 5: Verify**

Run:

    bun test test/unit/account-identity.test.ts test/unit/account-vault.test.ts
    bun run typecheck
    bun run lint

Expected: all pass.

**Step 6: Commit**

    git add src/accounts test/unit/account-vault.test.ts test/unit/account-identity.test.ts test/fixtures/oauth.ts
    git commit -m "feat: add secure codex account vault"

## Task 4: Fetch and reconcile fresh Codex usage

**Files**

- Create: src/usage/codex-usage.ts
- Create: src/usage/usage-service.ts
- Create: src/util/abort.ts
- Create: src/util/clock.ts
- Create: test/unit/codex-usage.test.ts
- Create: test/unit/usage-service.test.ts
- Create: test/fixtures/usage-responses.ts

**Step 1: Write failing parser and cache tests**

Fixture tests must cover current primary and secondary windows, missing secondary window, fractional percentages, second- and millisecond-based resets, malformed JSON, 401, 429, timeout, and abort.

UsageService tests must prove:

- five-minute freshness;
- per-account in-flight coalescing;
- at most two fetches concurrently;
- force refresh bypasses cache;
- last-good data is retained for 24 hours and marked stale;
- credentials do not appear in returned snapshots or errors.

**Step 2: Confirm the red state**

Run: bun test test/unit/codex-usage.test.ts test/unit/usage-service.test.ts

Expected: module-not-found failures.

**Step 3: Implement the pure parser**

    export function parseCodexUsage(
      body: unknown,
      observedAt: number,
    ): UsageSnapshot;

Normalize the provider's primary window to shortWindow and secondary window to weeklyWindow. Clamp usedPercent to 0 through 100. Preserve an absent reset as undefined rather than inventing a clock.

**Step 4: Implement the abortable fetch**

Request exactly https://chatgpt.com/backend-api/wham/usage with:

    Authorization: Bearer ACCESS_TOKEN
    ChatGPT-Account-Id: ACCOUNT_ID
    Accept: application/json

Use AbortSignal.any with the caller signal and a ten-second timeout. Convert errors to credential-free typed failures.

**Step 5: Implement the usage service**

Inject clock, random jitter, fetcher, concurrency gate, and state store. Fresh entries use a five-minute TTL with bounded jitter. Persist only UsageSnapshot.

**Step 6: Verify and commit**

Run:

    bun test test/unit/codex-usage.test.ts test/unit/usage-service.test.ts
    bun run typecheck
    bun run lint

Then:

    git add src/usage src/util test/unit/codex-usage.test.ts test/unit/usage-service.test.ts test/fixtures/usage-responses.ts
    git commit -m "feat: add fresh codex usage service"

## Task 5: Encode the quota-aware selection policy

**Files**

- Create: src/routing/selection-policy.ts
- Create: src/routing/selection-explanation.ts
- Create: test/unit/selection-policy.test.ts
- Create: test/fixtures/candidates.ts

**Step 1: Write the policy matrix as failing table tests**

Each row must name candidates, now, current account, config, expected account, and expected reason. Include:

- near-reset high remaining beats distant-reset low remaining;
- similar urgency drains least weekly remaining;
- weekly winner loses when short-window headroom is below 10%;
- weekly remaining below 3% is excluded;
- fresh beats penalized stale;
- data older than 24 hours is excluded;
- untouched/no-clock is excluded;
- healthy manual override wins;
- unhealthy manual override returns a visible override failure;
- current account remains inside 10% hysteresis;
- stable id breaks a complete tie.

**Step 2: Confirm the red state**

Run: bun test test/unit/selection-policy.test.ts

Expected: module-not-found failure.

**Step 3: Implement pure calculations**

    export function weeklyUrgency(snapshot: UsageSnapshot, now: number): number {
      const remaining = Math.max(
        0,
        1 - snapshot.weeklyWindow.usedPercent / 100,
      );
      const hours = Math.max(
        0.25,
        (snapshot.weeklyWindow.resetsAt - now) / 3_600_000,
      );
      return remaining / hours;
    }

    export function selectAccount(input: SelectionInput): SelectionDecision;

Selection proceeds in explicit phases: manual override; permanent and temporary exclusion; freshness tier; conservative headroom; urgency band; least weekly remaining; most short-window remaining; current-account affinity; stable id.

**Step 4: Make explanations first-class**

SelectionDecision includes every candidate with eligible, rejectionCode, effective remaining, urgency, freshness, tieBand, and selectedBecause. Rendering remains outside this module.

**Step 5: Verify and commit**

Run:

    bun test test/unit/selection-policy.test.ts
    bun run typecheck
    bun run lint

Then:

    git add src/routing/selection-policy.ts src/routing/selection-explanation.ts test/unit/selection-policy.test.ts test/fixtures/candidates.ts
    git commit -m "feat: add quota urgency selection policy"

## Task 6: Make selection atomic with cross-process reservations

**Files**

- Create: src/routing/reservation-store.ts
- Create: src/routing/select-and-reserve.ts
- Create: test/unit/reservation-store.test.ts
- Create: test/integration/concurrent-selection.test.ts
- Create: test/helpers/worker-select.ts

**Step 1: Write failing lease tests**

Cover owner identity, two-minute TTL, release ownership, expired cleanup, singleton primer lease, and a real two-process race where only one process receives the contested account.

The combined operation is:

    export async function selectAndReserve(input: {
      stateStore: AtomicJsonStore<RuntimeStateFile>;
      request: SelectionInput;
      owner: ReservationOwner;
      now: number;
    }): Promise<ReservedSelection>;

**Step 2: Confirm the red state**

Run:

    bun test test/unit/reservation-store.test.ts
    bun test test/integration/concurrent-selection.test.ts

Expected: module-not-found failures.

**Step 3: Implement one critical section**

Inside one stateStore.update:

1. discard expired reservations;
2. rebuild candidates from reloaded state;
3. call selectAccount;
4. add the selected lease;
5. persist the full explanation;
6. return the lease token and decision.

Release requires the opaque lease token. A different process or request cannot release it.

**Step 4: Verify and commit**

Run:

    bun test test/unit/reservation-store.test.ts
    bun test test/integration/concurrent-selection.test.ts
    bun run typecheck
    bun run lint

Then:

    git add src/routing/reservation-store.ts src/routing/select-and-reserve.ts test/unit/reservation-store.test.ts test/integration/concurrent-selection.test.ts test/helpers/worker-select.ts
    git commit -m "feat: coordinate account reservations"

## Task 7: Classify failures and persist bounded recovery state

**Files**

- Create: src/recovery/failure-classifier.ts
- Create: src/recovery/recovery-state.ts
- Create: src/recovery/wait-for-recovery.ts
- Create: test/unit/failure-classifier.test.ts
- Create: test/unit/recovery-state.test.ts
- Create: test/unit/wait-for-recovery.test.ts

**Step 1: Write failing classification tests**

Use provider-shaped errors without relying only on messages. Cover status 401 and 429, invalid_grant, revoked refresh, explicit usage-limit codes, generic rate-limit text, transport timeout, abort, and unrelated provider errors.

    type FailureClass =
      | { kind: "quota"; retryAt?: number }
      | { kind: "auth-retry" }
      | { kind: "auth-invalid" }
      | { kind: "transient"; retryAt: number }
      | { kind: "fatal" }
      | { kind: "aborted" };

**Step 2: Write failing recovery tests**

Prove:

- exhausted active windows block until the earliest relevant reset;
- missing reset uses a one-hour estimate capped at six hours;
- fresh usage may shorten an estimated quota cooldown without clearing authentication or transient blocks;
- fresh usage does not erase a later live error observation;
- all-blocked wait rechecks persisted state each minute;
- wait returns when a peer clears state;
- wait never exceeds six hours;
- caller abort ends immediately.

**Step 3: Implement and verify**

Run:

    bun test test/unit/failure-classifier.test.ts test/unit/recovery-state.test.ts test/unit/wait-for-recovery.test.ts
    bun run typecheck
    bun run lint

Expected: all pass.

**Step 4: Commit**

    git add src/recovery test/unit/failure-classifier.test.ts test/unit/recovery-state.test.ts test/unit/wait-for-recovery.test.ts
    git commit -m "feat: add bounded account recovery"

## Task 8: Implement the replay-safe routed stream

**Files**

- Create: src/stream/routed-stream.ts
- Create: src/stream/replay-boundary.ts
- Create: src/stream/stream-attempt.ts
- Create: test/unit/replay-boundary.test.ts
- Create: test/integration/routed-stream.test.ts
- Create: test/fixtures/provider-streams.ts

**Step 1: Lock down the replay boundary**

Write failing tests showing:

- start alone remains replay-safe;
- text_start, text_delta, thinking_start, thinking_delta, toolcall_start, and toolcall_delta make replay unsafe;
- completion and post-output errors release the reservation once;
- caller abort is never retried.

**Step 2: Write routed failover tests**

Use a fake StreamFunction. Cover pre-output quota rotation, one forced token refresh for a first 401, definitive auth rotation, maximum five attempts, no account repeated before recovery, eligible accounts becoming retryable after cooldown, an all-limited recovery wait with one cumulative deadline, post-output error pass-through, exact event order, and signal propagation.

**Step 3: Confirm the red state**

Run:

    bun test test/unit/replay-boundary.test.ts
    bun test test/integration/routed-stream.test.ts

Expected: module-not-found failures.

**Step 4: Implement dependency-injected routing**

    export interface RoutedStreamDependencies {
      selectAndReserve(request: RouteRequest): Promise<ReservedSelection>;
      getFreshCredential(accountId: string, signal?: AbortSignal): Promise<FreshCredential>;
      baseStream: StreamFunction<"openai-codex-responses">;
      classifyFailure(error: unknown): FailureClass;
      recordFailure(accountId: string, failure: FailureClass): Promise<void>;
      release(leaseToken: string): Promise<void>;
      waitForRecovery(signal?: AbortSignal): Promise<void>;
    }

    export function createRoutedStream(
      dependencies: RoutedStreamDependencies,
    ): StreamFunction<"openai-codex-responses">;

For every attempt, clone options and replace only apiKey. Preserve model, context, thinking level, signal, headers, session id, transport settings, and payload callback.

Do not buffer model output. Forward each event immediately while updating ReplayBoundary. Rotate only if classifyFailure is recoverable and ReplayBoundary remains safe.

**Step 5: Verify and commit**

Run:

    bun test test/unit/replay-boundary.test.ts
    bun test test/integration/routed-stream.test.ts
    bun run typecheck
    bun run lint

Then:

    git add src/stream test/unit/replay-boundary.test.ts test/integration/routed-stream.test.ts test/fixtures/provider-streams.ts
    git commit -m "feat: add replay-safe routed stream"

## Task 9: Add explicitly authorized one-shot priming

**Files**

- Create: src/priming/priming-controller.ts
- Create: src/priming/primer-request.ts
- Create: test/unit/priming-controller.test.ts
- Create: test/integration/priming-concurrency.test.ts

**Step 1: Write failing authorization and behavior tests**

Prove:

- neither flag alone permits a request;
- candidate requires fresh 0% in both windows and no weekly reset;
- foreground activity prevents a primer from starting;
- primer sweep lease prevents two Pi processes from priming;
- one confirmed command sends at most one provider request, even when scanning all accounts;
- request contains no history or tools, exact prompt ".", lowest supported reasoning, and smallest output budget;
- usage is force-refreshed after every non-aborted provider attempt, including failure;
- only an observed weekly reset marks confirmed;
- a provider failure remains failed even when the usage observation confirms the account;
- inconclusive/failure without an observed reset applies one-hour cooldown;
- shutdown aborts work and releases both leases.

**Step 2: Confirm the red state**

Run:

    bun test test/unit/priming-controller.test.ts
    bun test test/integration/priming-concurrency.test.ts

Expected: module-not-found failures.

**Step 3: Implement an idle-only, one-shot controller**

    export interface PrimingController {
      scheduleSweep(reason: "startup" | "manual" | "idle"): void;
      primeAccount(id: string, signal?: AbortSignal): Promise<PrimerResult>;
      setForegroundActive(active: boolean): void;
      shutdown(): Promise<void>;
    }

The synthetic request uses the same current model as Pi, never switches models, and bypasses normal routing only after explicitly reserving the target account.

Command confirmations authorize only the current invocation. They do not persist the automatic-priming flags, and normal agent settlement does not schedule a sweep. The `all` selector may skip ineligible accounts but stops after the first actual primer request and its forced usage refresh.

**Step 4: Verify and commit**

Run:

    bun test test/unit/priming-controller.test.ts
    bun test test/integration/priming-concurrency.test.ts
    bun run typecheck
    bun run lint

Then:

    git add src/priming test/unit/priming-controller.test.ts test/integration/priming-concurrency.test.ts
    git commit -m "feat: add explicit account priming"

## Task 10: Wire the normal-Pi provider override

**Files**

- Create: src/provider.ts
- Create: src/router-controller.ts
- Create: src/extension.ts
- Modify: src/index.ts
- Create: test/integration/provider-registration.test.ts
- Create: test/fixtures/pi-api.ts

**Step 1: Write failing provider contract tests**

Capture calls to a fake ExtensionAPI and prove:

- exactly openai-codex is registered;
- built-in model ids and metadata remain byte-for-byte equivalent after removing functions;
- streamSimple is the routed wrapper;
- existing account token is used only as the registration key;
- an empty vault uses pending-login;
- pending-login is never passed to the base stream;
- chosen model and thinking options reach the base stream unchanged;
- shutdown closes the controller.

**Step 2: Confirm the red state**

Run: bun test test/integration/provider-registration.test.ts

Expected: module-not-found failure.

**Step 3: Use public Pi exports only**

Import:

    import { streamSimple as codexStreamSimple } from
      "@earendil-works/pi-ai/api/openai-codex-responses";
    import { OPENAI_CODEX_MODELS } from
      "@earendil-works/pi-ai/providers/openai-codex.models";

Convert each model to Pi's provider registration shape without editing id, name, baseUrl, input, reasoning, thinkingLevelMap, cost, contextWindow, or maxTokens.

Register:

    pi.registerProvider("openai-codex", {
      name: "OpenAI Codex (Quota Router)",
      api: "openai-codex-responses",
      apiKey: bootstrapKey,
      models,
      streamSimple: createRoutedStream(controller.dependencies),
    });

If the vault is empty, bootstrapKey is pending-login. The routed stream checks the account list and throws a credential-free local error directing the user to /quota-router login before invoking codexStreamSimple.

**Step 4: Wire lifecycle**

- construct one RouterController in the async extension factory;
- mark foreground active on agent_start;
- mark idle on agent_settled without scheduling background priming;
- abort background work and release local leases on session_shutdown;
- do no network work merely to render startup.

**Step 5: Verify and commit**

Run:

    bun test test/integration/provider-registration.test.ts
    bun run typecheck
    bun run lint

Then:

    git add src/provider.ts src/router-controller.ts src/extension.ts src/index.ts test/integration/provider-registration.test.ts test/fixtures/pi-api.ts
    git commit -m "feat: register normal pi quota router"

## Task 11: Add command UX, login, status, and redacted diagnostics

**Files**

- Create: src/commands/commands.ts
- Create: src/commands/parser.ts
- Create: src/commands/login.ts
- Create: src/status/status-controller.ts
- Create: src/status/format.ts
- Create: src/logging/event-log.ts
- Create: src/logging/redact.ts
- Modify: src/extension.ts
- Create: test/unit/command-parser.test.ts
- Create: test/unit/redact.test.ts
- Create: test/integration/commands.test.ts
- Create: test/integration/status.test.ts

**Step 1: Write failing parser and redaction tests**

Test every documented subcommand, quoted labels, unknown command help, invalid account names, newline stripping, bearer tokens, JWT-like values, API-key-like values, and long opaque identifiers.

**Step 2: Write failing command integration tests**

Prove that status, accounts, login, use, refresh, prime, policy, reset, verify, path, and log call structured controller methods. Mutating commands must print exact outcomes. Prime must obtain both ephemeral confirmations before scheduling synthetic spend without persisting that authorization.

Login uses `loginOpenAICodex` from `@earendil-works/pi-ai/oauth`, validates the fixed client, callback, state, and PKCE authorization URL, and maps Pi UI callbacks through the argument-safe authorization actions:

    const credentials = await loginOpenAICodex({
      originator: "pi-quota-router",
      onAuth: ({ url }) => presentValidatedAuthorizationActions(ctx, url),
      onPrompt: ({ message, placeholder }) => ctx.ui.input(message, placeholder),
      onManualCodeInput: () => promptForAuthorizationCode(ctx),
    });

Adapt the exact UI calls to the public `ExtensionCommandContext` types at Pi 0.80.6. Browser and clipboard processes use fixed executable names, explicit arguments, and no shell; upstream OAuth failures are replaced with a credential-free message.

**Step 3: Add status and footer**

The compact format is:

    Codex · LABEL · 5h 72% · 7d 41%/18h · urgent 0.023/h · auto

Use remaining percentages consistently. Render manual, stale, cooldown, reserved, or primer in the final slot. UI rendering reads cached state and never blocks on usage fetch.

**Step 4: Add bounded diagnostics**

Append newline-delimited credential-free events under a lock. Rotate at 4 MiB to one predecessor. Apply redact to the fully serialized event before writing. Logging failure must not fail a routed request.

**Step 5: Verify and commit**

Run:

    bun test test/unit/command-parser.test.ts test/unit/redact.test.ts
    bun test test/integration/commands.test.ts test/integration/status.test.ts
    bun run typecheck
    bun run lint

Then:

    git add src/commands src/status src/logging src/extension.ts test/unit/command-parser.test.ts test/unit/redact.test.ts test/integration/commands.test.ts test/integration/status.test.ts
    git commit -m "feat: add quota router operations ui"

## Task 12: Add end-to-end guarantees and external Pi smoke tests

**Files**

- Create: test/e2e/router-guarantees.test.ts
- Create: test/e2e/pi-load.test.ts
- Create: test/helpers/fake-codex-server.ts
- Create: test/helpers/isolated-home.ts
- Create: scripts/smoke-install.ts
- Modify: package.json

**Step 1: Write guarantee-driven end-to-end tests**

In isolated PI_CODING_AGENT_DIR directories, prove:

- a healthy account is selected from fresh usage;
- two concurrent Pi controllers reserve different accounts;
- the account with the most urgent expiring useful quota is selected;
- a pre-output 429 rotates once and completes;
- a post-output 429 is delivered without replay;
- a primer cannot run without confirmation;
- an authorized untouched account is primed once and enters normal routing;
- invalid_grant stays excluded until reauthentication;
- Ctrl-C aborts an all-limited wait;
- no fixture secret appears anywhere outside accounts.json.

**Step 2: Add external package load smoke**

scripts/smoke-install.ts must:

1. create a temp project outside this repository;
2. run bun pm pack --ignore-scripts;
3. install the tarball and Pi 0.80.6 with Bun;
4. run Pi's extension listing or model listing against an isolated home;
5. assert that openai-codex models appear unchanged;
6. assert that no private Pi source path is imported.

**Step 3: Verify**

Run:

    bun test test/e2e/router-guarantees.test.ts
    bun test test/e2e/pi-load.test.ts
    bun run scripts/smoke-install.ts
    bun run check
    bun pm pack --dry-run --ignore-scripts

Expected: all pass and the dry-run contains only src, README.md, LICENSE, and package metadata.

**Step 4: Commit**

    git add test/e2e test/helpers scripts/smoke-install.ts package.json bun.lock
    git commit -m "test: add quota router guarantees"

## Task 13: Document installation, policy, and recovery

**Files**

- Modify: README.md
- Create: docs/policy.md
- Create: docs/security.md
- Create: docs/troubleshooting.md
- Create: LICENSE

**Step 1: Write executable documentation examples**

README includes:

- Bun-based development and normal-Pi installation;
- first /quota-router login;
- automatic selection formula with one worked example;
- why the router drains urgent quota instead of equalizing use;
- explicit primer warning and both confirmations;
- footer legend;
- every subcommand;
- files and permission modes;
- uninstallation without credential loss and explicit credential deletion;
- Node runtime compatibility despite Bun development.

**Step 2: Add operational guides**

docs/policy.md mirrors tested eligibility, urgency, tie-break, hysteresis, and manual rules. docs/security.md documents token boundaries, endpoint allowlist, locks, permissions, backups, and threat limits. docs/troubleshooting.md maps every typed error and /quota-router verify result to a concrete recovery step.

**Step 3: Check docs against tests**

Run:

    rg -n "10%|3%|five minutes|24 hours|six hours|one hour|two minutes" README.md docs src test
    bun run check
    bun pm pack --dry-run --ignore-scripts

Expected: documented constants match source defaults and policy tests.

**Step 4: Commit**

    git add README.md docs/policy.md docs/security.md docs/troubleshooting.md LICENSE
    git commit -m "docs: document quota router operations"

## Task 14: Run the release safety gate

**Files**

- Create: .github/workflows/ci.yml
- Create: .github/dependabot.yml
- Create: scripts/check-secrets.ts
- Modify: package.json

**Step 1: Add CI with the same Bun commands**

CI runs on Node 22 and the pinned Bun version:

    bun install --frozen-lockfile --ignore-scripts
    bun run lint
    bun run typecheck
    bun test
    bun pm scan
    bun run scripts/check-secrets.ts
    bun run scripts/smoke-install.ts
    bun pm pack --dry-run --ignore-scripts

The secret check scans tracked files and test output for fixture access tokens, refresh tokens, and JWT patterns. Use synthetic fixtures only.

**Step 2: Run the complete local gate**

Run:

    bun install --frozen-lockfile --ignore-scripts
    bun run check
    bun pm scan
    bun run scripts/check-secrets.ts
    bun run scripts/smoke-install.ts
    bun pm pack --dry-run --ignore-scripts
    git diff --check
    git status --short

Expected: every command passes; package audit has no unresolved high or critical production advisory; worktree contains only the intended CI changes.

**Step 3: Manual normal-Pi acceptance**

Using throwaway test accounts only:

1. install the packed extension in a clean normal-Pi profile;
2. login two accounts;
3. verify fresh 5-hour and weekly usage;
4. compare /quota-router status ranking with the formula;
5. run a prompt and confirm model/thinking identity is unchanged;
6. simulate one pre-output quota failure and verify a single rotation;
7. confirm no rotation occurs after visible output;
8. confirm one-shot priming, then verify exactly one untouched account obtains an observed weekly reset and no background primer is scheduled;
9. run two Pi processes and verify distinct leases;
10. inspect permissions and redacted logs.

Do not run synthetic primers against real accounts until the provider's first-use rolling-window behavior is independently confirmed.

**Step 4: Commit and push**

    git add .github/workflows/ci.yml .github/dependabot.yml scripts/check-secrets.ts package.json bun.lock
    git commit -m "ci: add bun release safety gate"
    git push

## Implementation order and risk checkpoints

The dependency order is Tasks 1 through 14. Do not start Pi UI work before Tasks 2 through 9 pass, because storage, selection, stream replay, and primer authorization are the safety-critical core.

Stop for a design review if any of these facts prove false against the then-current normal Pi release:

- openai-codex can no longer be overridden with registerProvider;
- public exports no longer expose the Codex stream or model metadata;
- a transport start event contains model-visible content;
- the usage endpoint no longer exposes both active windows and resets;
- OAuth refresh rotates refresh tokens in a way the locked vault cannot persist safely.

When Pi releases a newer minor version during implementation, first run the provider-registration, routed-stream, and external-load test suites against it. Raise the peer range only after those tests pass.

## Final definition of done

- All 14 task commits exist with green task-local tests.
- bun run check, bun pm scan, the external install smoke, and pack dry-run pass.
- The private repository contains no real credentials or raw account ids.
- The extension works in a clean normal-Pi profile and preserves model/thinking identity.
- Selection explanations match the quota-aware policy and fresh data.
- Priming is explicit, minimal, sequential, verified, and off by default.
- Cross-process reservations and refresh locks withstand the concurrency tests.
- Pre-output failover is transparent; post-output replay is impossible by construction and test.
- README, policy, security, and troubleshooting docs match tested behavior.
