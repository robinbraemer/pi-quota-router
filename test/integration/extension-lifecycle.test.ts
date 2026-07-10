import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExtension } from "../../src/extension.ts";
import type { RouterController } from "../../src/router-controller.ts";

describe("extension lifecycle", () => {
  test("tracks foreground state without scheduling background priming, and shuts down", async () => {
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const foreground: boolean[] = [];
    let priming = 0;
    let shutdown = 0;
    const pi = {
      registerProvider: () => undefined,
      registerCommand: () => undefined,
      on: (name: string, handler: (...args: never[]) => unknown) => handlers.set(name, handler),
    } as unknown as ExtensionAPI;
    const controller = {
      bootstrapApiKey: "pending-login",
      routedStream: () => {
        throw new Error("unused");
      },
      vault: {},
      assertReady: async () => undefined,
      setForegroundActive: (active: boolean) => foreground.push(active),
      schedulePriming: () => {
        priming += 1;
      },
      shutdown: async () => {
        shutdown += 1;
      },
      operations: {
        status: async () => "Codex · none · login",
      },
    } as unknown as RouterController;
    await createExtension(async () => controller)(pi);

    const ctx = {
      ui: { setStatus: () => undefined },
    };
    await handlers.get("agent_start")?.({} as never, ctx as never);
    await handlers.get("agent_settled")?.({} as never, ctx as never);
    await handlers.get("session_shutdown")?.({} as never, ctx as never);
    expect(foreground).toEqual([true, false]);
    expect(priming).toBe(0);
    expect(shutdown).toBe(1);
  });
});
