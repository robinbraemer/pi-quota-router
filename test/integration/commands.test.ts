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
        "list",
        "login",
        "use",
        "refresh",
        "prime",
        "policy",
        "reset",
        "verify",
        "paths",
        "log",
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
        setStatus: () => undefined,
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
      "list",
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
      "accounts:",
      "login:Work",
      "status:",
      "use:auto",
      "refresh:all",
      "prime:all",
      "policy:",
      "reset:all",
      "verify:",
      "paths:",
      "log:on",
    ]);
    expect(notifications).toHaveLength(13);
  });

  test("passes the current model to explicit priming", async () => {
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const calls: unknown[][] = [];
    const pi = {
      registerCommand: (_name: string, options: { handler: typeof handler }) => {
        handler = options.handler;
      },
    } as unknown as ExtensionAPI;
    const operations = {
      prime: async (...args: unknown[]) => {
        calls.push(args);
        return "primed";
      },
      confirmPriming: async () => "confirmed",
    } as unknown as QuotaRouterOperations;
    const ctx = {
      model: { id: "gpt-5.2-codex" },
      ui: {
        notify: () => undefined,
        confirm: async () => true,
      },
    } as unknown as ExtensionCommandContext;
    registerQuotaRouterCommands(pi, operations);
    if (!handler) {
      throw new Error("command was not registered");
    }

    await handler("prime all", ctx);

    expect(calls).toEqual([["all", "gpt-5.2-codex"]]);
  });

  test("rerenders footer status before a successful login command resolves", async () => {
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const sequence: string[] = [];
    const pi = {
      registerCommand: (_name: string, options: { handler: typeof handler }) => {
        handler = options.handler;
      },
    } as unknown as ExtensionAPI;
    const operations = {
      login: async () => {
        sequence.push("login");
        return "Added Codex account work (codex-a)";
      },
      status: async () => {
        sequence.push("status");
        return "Codex · work · auto";
      },
    } as unknown as QuotaRouterOperations;
    const ctx = {
      ui: {
        notify: (message: string) => sequence.push(`notify:${message}`),
        setStatus: (key: string, value: string) => sequence.push(`footer:${key}:${value}`),
      },
    } as unknown as ExtensionCommandContext;
    registerQuotaRouterCommands(pi, operations);
    if (!handler) {
      throw new Error("command was not registered");
    }

    await handler("login work", ctx);

    expect(sequence).toEqual([
      "login",
      "status",
      "footer:quota-router:Codex · work · auto",
      "notify:Added Codex account work (codex-a)",
    ]);
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

  test("authorizes only the current one-shot prime command", async () => {
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const calls: string[] = [];
    const pi = {
      registerCommand: (_name: string, options: { handler: typeof handler }) => {
        handler = options.handler;
      },
    } as unknown as ExtensionAPI;
    const operations = {
      prime: async (selector?: string) => {
        calls.push(`prime:${selector ?? ""}`);
        return "work: confirmed";
      },
      confirmPriming: async () => {
        calls.push("persistent-confirmation");
        return "enabled";
      },
    } as unknown as QuotaRouterOperations;
    const ctx = {
      ui: {
        notify: () => undefined,
        confirm: async () => true,
      },
    } as unknown as ExtensionCommandContext;
    registerQuotaRouterCommands(pi, operations);
    if (!handler) throw new Error("command was not registered");

    await handler("prime work", ctx);

    expect(calls).toEqual(["prime:work"]);
  });

  test("primes with the model selected in the command context", async () => {
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const calls: string[] = [];
    const pi = {
      registerCommand: (_name: string, options: { handler: typeof handler }) => {
        handler = options.handler;
      },
    } as unknown as ExtensionAPI;
    const operations = {
      prime: async (selector?: string, modelId?: string) => {
        calls.push(`${selector}:${modelId}`);
        return "work: confirmed";
      },
    } as unknown as QuotaRouterOperations;
    const ctx = {
      model: { id: "gpt-selected" },
      ui: {
        notify: () => undefined,
        confirm: async () => true,
      },
    } as unknown as ExtensionCommandContext;
    registerQuotaRouterCommands(pi, operations);
    if (!handler) throw new Error("command was not registered");

    await handler("prime work", ctx);

    expect(calls).toEqual(["work:gpt-selected"]);
  });

  test("rerenders the footer immediately after a successful login", async () => {
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const events: string[] = [];
    const pi = {
      registerCommand: (_name: string, options: { handler: typeof handler }) => {
        handler = options.handler;
      },
    } as unknown as ExtensionAPI;
    const operations = {
      login: async () => {
        events.push("login");
        return "Added Codex account work (codex-a)";
      },
      status: async () => {
        events.push("status");
        return "Codex · work · auto";
      },
    } as unknown as QuotaRouterOperations;
    const ctx = {
      ui: {
        setStatus: (key: string, value: string) => events.push(`setStatus:${key}:${value}`),
        notify: (message: string) => events.push(`notify:${message}`),
      },
    } as unknown as ExtensionCommandContext;
    registerQuotaRouterCommands(pi, operations);
    if (!handler) throw new Error("command was not registered");

    await handler("login work", ctx);

    expect(events).toEqual([
      "login",
      "status",
      "setStatus:quota-router:Codex · work · auto",
      "notify:Added Codex account work (codex-a)",
    ]);
  });

  test("makes every subcommand discoverable from the dashboard and help alias", async () => {
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: (_name: string, options: { handler: typeof handler }) => {
        handler = options.handler;
      },
    } as unknown as ExtensionAPI;
    const operations = {
      dashboard: async () => "Codex · work · auto",
    } as unknown as QuotaRouterOperations;
    const notifications: string[] = [];
    const ctx = {
      ui: {
        notify: (message: string) => notifications.push(message),
      },
    } as unknown as ExtensionCommandContext;
    registerQuotaRouterCommands(pi, operations);
    if (!handler) throw new Error("command was not registered");

    await handler("", ctx);
    await handler("help", ctx);

    expect(notifications).toHaveLength(2);
    for (const output of notifications) {
      expect(output).toContain("QUICK COMMANDS");
      for (const highlighted of [
        "/quota-router login [label]",
        "/quota-router list",
        "/quota-router status",
        "/quota-router use auto",
        "/quota-router refresh [account|all]",
        "/quota-router prime [account|all]",
      ]) {
        expect(output).toContain(`◆ ${highlighted}`);
      }
      for (const secondary of ["use <account>", "policy", "reset", "verify", "path", "log"]) {
        expect(output).toContain(`/quota-router ${secondary}`);
      }
    }
  });
});
