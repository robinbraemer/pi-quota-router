import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type QuotaRouterOperations,
  registerQuotaRouterCommands,
} from "../../src/commands/commands.ts";

describe("/quota-router commands", () => {
  test("dispatches every subcommand to structured operations", async () => {
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const calls: string[] = [];
    const pi = {
      registerCommand: (_name: string, options: { handler: typeof handler }) => {
        handler = options.handler;
      },
    } as unknown as ExtensionAPI;
    const operations = Object.fromEntries(
      [
        "dashboard",
        "status",
        "accounts",
        "login",
        "use",
        "refresh",
        "prime",
        "policy",
        "reset",
        "verify",
        "paths",
        "log",
        "confirmPriming",
      ].map((name) => [
        name,
        async (...args: unknown[]) => {
          calls.push(`${name}:${args.filter((arg) => typeof arg === "string").join(",")}`);
          return `${name} ok`;
        },
      ]),
    ) as unknown as QuotaRouterOperations;
    const notifications: string[] = [];
    const ctx = {
      ui: {
        notify: (message: string) => notifications.push(message),
        confirm: async () => true,
      },
    } as unknown as ExtensionCommandContext;
    registerQuotaRouterCommands(pi, operations);
    if (!handler) {
      throw new Error("command was not registered");
    }

    for (const args of [
      "",
      "status",
      "accounts",
      'login "Work"',
      "use auto",
      "refresh all",
      "prime all",
      "policy",
      "reset all",
      "verify",
      "path",
      "log on",
    ]) {
      await handler(args, ctx);
    }

    expect(calls).toEqual([
      "dashboard:",
      "status:",
      "accounts:",
      "login:Work",
      "use:auto",
      "refresh:all",
      "confirmPriming:",
      "prime:all",
      "policy:",
      "reset:all",
      "verify:",
      "paths:",
      "log:on",
    ]);
    expect(notifications).toHaveLength(12);
  });

  test("requires both explicit confirmations before priming", async () => {
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    let primes = 0;
    const pi = {
      registerCommand: (_name: string, options: { handler: typeof handler }) => {
        handler = options.handler;
      },
    } as unknown as ExtensionAPI;
    const operations = {
      prime: async () => {
        primes += 1;
        return "primed";
      },
      confirmPriming: async () => "confirmed",
    } as unknown as QuotaRouterOperations;
    let confirmations = 0;
    const ctx = {
      ui: {
        notify: () => undefined,
        confirm: async () => {
          confirmations += 1;
          return confirmations === 1;
        },
      },
    } as unknown as ExtensionCommandContext;
    registerQuotaRouterCommands(pi, operations);
    if (!handler) {
      throw new Error("command was not registered");
    }
    await handler("prime all", ctx);
    expect(confirmations).toBe(2);
    expect(primes).toBe(0);
  });
});
