import { describe, expect, test } from "bun:test";
import { CommandParseError, parseQuotaRouterCommand } from "../../src/commands/parser.ts";

describe("quota-router command parser", () => {
  test("recognizes the dashboard and every documented subcommand", () => {
    expect(parseQuotaRouterCommand("")).toEqual({ command: "dashboard", args: [] });
    for (const command of [
      "status",
      "accounts",
      "list",
      "help",
      "login",
      "use",
      "refresh",
      "prime",
      "policy",
      "reset",
      "verify",
      "path",
      "log",
    ] as const) {
      expect(parseQuotaRouterCommand(command).command).toBe(command);
    }
  });

  test("preserves quoted labels as one argument", () => {
    expect(parseQuotaRouterCommand('login "Work Account"')).toEqual({
      command: "login",
      args: ["Work Account"],
    });
  });

  test("recognizes list as a first-class managed-account command", () => {
    expect(parseQuotaRouterCommand("list")).toEqual({ command: "list", args: [] });
  });

  test("rejects unknown commands, unclosed quotes, and invalid account selectors", () => {
    expect(() => parseQuotaRouterCommand("wat")).toThrow(CommandParseError);
    expect(() => parseQuotaRouterCommand('login "work')).toThrow(CommandParseError);
    expect(() => parseQuotaRouterCommand("use ../accounts.json")).toThrow(CommandParseError);
  });
});
