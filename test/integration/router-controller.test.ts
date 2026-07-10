import { afterEach, describe, expect, test } from "bun:test";
import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { createRouterController } from "../../src/router-controller.ts";
import { resolveRouterPaths } from "../../src/storage/paths.ts";
import { makeCredentials } from "../fixtures/oauth.ts";
import { eventStream, successfulText } from "../fixtures/provider-streams.ts";
import { createStorageFixture } from "../fixtures/storage.ts";
import { completeUsageResponse } from "../fixtures/usage-responses.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("RouterController", () => {
  test("routes after login and refuses to expose the bootstrap sentinel", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    let backendKey: string | undefined;
    const controller = await createRouterController({
      paths: resolveRouterPaths(fixture.directory),
      clock: () => 2_000_000_000_000,
      oauth: { refresh: async () => makeCredentials("account-1", 3_000_000_000_000) },
      fetchImpl: async () => Response.json(completeUsageResponse),
      baseStream: (_model, _context, options) => {
        backendKey = options?.apiKey;
        return eventStream(successfulText());
      },
    });
    await expect(controller.assertReady()).rejects.toThrow("/quota-router login");
    await controller.vault.addFromOAuth("work", makeCredentials("account-1", 3_000_000_000_000));
    await controller.assertReady();
    expect(await controller.operations.accounts()).toContain("work");
    expect(await controller.operations.use("auto")).toContain("automatic");

    const model = Object.values(OPENAI_CODEX_MODELS)[0] as Model<"openai-codex-responses">;
    const events: AssistantMessageEvent[] = [];
    for await (const event of controller.routedStream(model, { messages: [] } as Context)) {
      events.push(event);
    }
    expect(events.at(-1)?.type).toBe("done");
    expect(backendKey).not.toBe("pending-login");
    expect(backendKey).toContain(".");
    expect(await controller.operations.status()).toContain("work");
    expect(await controller.operations.verify()).toContain("healthy");
    expect(await controller.operations.paths()).toContain("accounts.json");
    await controller.shutdown();
  });
});
