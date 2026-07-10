export type QuotaRouterCommand =
  | "dashboard"
  | "status"
  | "accounts"
  | "login"
  | "use"
  | "refresh"
  | "prime"
  | "policy"
  | "reset"
  | "verify"
  | "path"
  | "log";

const COMMANDS = new Set<QuotaRouterCommand>([
  "status",
  "accounts",
  "login",
  "use",
  "refresh",
  "prime",
  "policy",
  "reset",
  "verify",
  "path",
  "log",
]);

export class CommandParseError extends Error {
  override readonly name = "CommandParseError";
}

export function parseQuotaRouterCommand(input: string): {
  command: QuotaRouterCommand;
  args: string[];
} {
  const tokens = tokenize(input);
  if (tokens.length === 0) {
    return { command: "dashboard", args: [] };
  }
  const candidate = tokens[0];
  if (!candidate || !COMMANDS.has(candidate as QuotaRouterCommand)) {
    throw new CommandParseError(
      "Unknown quota-router command. Use status, accounts, login, use, refresh, prime, policy, reset, verify, path, or log.",
    );
  }
  const command = candidate as QuotaRouterCommand;
  const args = tokens.slice(1);
  validate(command, args);
  return { command, args };
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (const character of input.trim()) {
    if (escaping) {
      current += character;
      escaping = false;
    } else if (character === "\\") {
      escaping = true;
    } else if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (escaping || quote) {
    throw new CommandParseError("The command contains an unclosed quote or escape");
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function validate(command: QuotaRouterCommand, args: string[]): void {
  const maximum = command === "dashboard" ? 0 : command === "login" ? 1 : 1;
  if (args.length > maximum) {
    throw new CommandParseError(`Too many arguments for ${command}`);
  }
  if (
    command === "reset" &&
    args[0] &&
    !["cooldowns", "reservations", "priming", "all"].includes(args[0])
  ) {
    throw new CommandParseError("reset requires cooldowns, reservations, priming, or all");
  }
  if (command === "log" && args[0] && !["on", "off"].includes(args[0])) {
    throw new CommandParseError("log accepts only on or off");
  }
  if (["use", "refresh", "prime"].includes(command) && args[0]) {
    const selector = args[0];
    if (
      selector.includes("..") ||
      selector.includes("/") ||
      selector.includes("\\") ||
      Array.from(selector).some((character) => (character.codePointAt(0) ?? 0) < 0x20)
    ) {
      throw new CommandParseError("Invalid account selector");
    }
  }
}
