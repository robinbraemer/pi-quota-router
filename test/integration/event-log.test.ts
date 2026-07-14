import { afterEach, describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import type { Context, Model } from "@earendil-works/pi-ai";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { createEventLog } from "../../src/logging/event-log.ts";
import { createRouterController } from "../../src/router-controller.ts";
import { createAtomicJsonStore } from "../../src/storage/atomic-json-store.ts";
import { resolveRouterPaths } from "../../src/storage/paths.ts";
import {
  defaultRuntimeState,
  type RuntimeStateFile,
  RuntimeStateFileSchema,
} from "../../src/storage/schemas.ts";
import type { Reservation } from "../../src/types.ts";
import { makeCredentials } from "../fixtures/oauth.ts";
import { eventStream, successfulText } from "../fixtures/provider-streams.ts";
import { createStorageFixture } from "../fixtures/storage.ts";
import { completeUsageResponse } from "../fixtures/usage-responses.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("bounded event log", () => {
  test("records only the aggregate foreground overlap on account selection", async () => {
    const fixture = await createStorageFixture();
    const paths = resolveRouterPaths(fixture.directory);
    let controller: Awaited<ReturnType<typeof createRouterController>> | undefined;
    cleanups.push(async () => {
      await controller?.shutdown();
      await fixture.cleanup();
    });
    controller = await createRouterController({
      paths,
      clock: () => 2_000_000_000_000,
      oauth: {
        refresh: async () => makeCredentials("raw-provider-identity-sentinel", 3_000_000_000_000),
      },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: () => eventStream(successfulText()),
    });
    const managedId = await controller.vault.addFromOAuth(
      "work",
      makeCredentials("raw-provider-identity-sentinel", 3_000_000_000_000),
    );
    const stateStore = createAtomicJsonStore<RuntimeStateFile>({
      path: paths.state,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    const peer = (index: number): Reservation => ({
      accountId: managedId,
      leaseToken: `synthetic-peer-${index}`,
      owner: {
        processId: 7,
        sessionId: `peer-session-${index}`,
        requestId: `peer-request-${index}`,
      },
      createdAt: 2_000_000_000_000,
      expiresAt: 2_000_000_060_000,
      kind: "foreground",
    });
    const model = Object.values(OPENAI_CODEX_MODELS)[0] as Model<"openai-codex-responses">;
    const route = async () => {
      for await (const _event of controller.routedStream(model, { messages: [] } as Context, {
        sessionId: "request-session",
      })) {
        // Consume the complete synthetic stream.
      }
    };

    await route();
    await stateStore.update((state) => ({ ...state, reservations: [peer(1)] }));
    await route();
    await stateStore.update((state) => ({
      ...state,
      reservations: [peer(1), peer(2), peer(3)],
    }));
    await route();

    const logText = await readFile(paths.log, "utf8");
    const selectedEvents = logText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.type === "account_selected");
    expect(
      selectedEvents.map(
        (event) => (event.detail as { foregroundActiveBefore?: number }).foregroundActiveBefore,
      ),
    ).toEqual([0, 1, 3]);
    expect(selectedEvents.every((event) => event.accountId === managedId)).toBeTrue();
    expect(logText).not.toContain("peer-session");
    expect(logText).not.toContain("peer-request");
    expect(logText).not.toContain("raw-provider-identity-sentinel");
  });

  test("redacts serialized events and writes private files", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const log = createEventLog({ path: fixture.file });
    expect(
      await log.append({
        type: "request_completed",
        at: 1,
        detail: { secret: "Bearer secret-token-value" },
      }),
    ).toBe(true);
    const content = await readFile(fixture.file, "utf8");
    expect(content).not.toContain("secret-token-value");
    expect(content).toContain("[REDACTED]");
    expect((await stat(fixture.file)).mode & 0o777).toBe(0o600);
  });

  test("keeps only one rotated predecessor", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const log = createEventLog({ path: fixture.file, maxBytes: 100 });
    for (let index = 0; index < 5; index += 1) {
      await log.append({
        type: "request_completed",
        at: index,
        detail: { text: "x".repeat(60) },
      });
    }
    expect(await readFile(`${fixture.file}.1`, "utf8")).not.toBe("");
    expect((await stat(fixture.file)).size).toBeLessThanOrEqual(200);
  });
});
