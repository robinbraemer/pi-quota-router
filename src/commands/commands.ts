import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CommandParseError, parseQuotaRouterCommand } from "./parser.ts";

export interface QuotaRouterOperations {
  dashboard(): Promise<string>;
  status(): Promise<string>;
  accounts(): Promise<string>;
  login(label: string | undefined, ctx: ExtensionCommandContext): Promise<string>;
  use(selector: string): Promise<string>;
  refresh(selector?: string): Promise<string>;
  prime(selector?: string): Promise<string>;
  policy(): Promise<string>;
  reset(scope: string): Promise<string>;
  verify(): Promise<string>;
  paths(): Promise<string>;
  log(mode?: string): Promise<string>;
}

export function registerQuotaRouterCommands(
  pi: ExtensionAPI,
  operations: QuotaRouterOperations,
): void {
  pi.registerCommand("quota-router", {
    description: "Manage quota-aware Codex account routing",
    handler: async (input, ctx) => {
      try {
        const parsed = parseQuotaRouterCommand(input);
        let result: string;
        switch (parsed.command) {
          case "dashboard":
          case "help":
            result = formatQuotaRouterDashboard(await operations.dashboard());
            break;
          case "status":
            result = await operations.status();
            break;
          case "accounts":
          case "list":
            result = await operations.accounts();
            break;
          case "login":
            result = await operations.login(parsed.args[0], ctx);
            ctx.ui.setStatus("quota-router", await operations.status());
            break;
          case "use":
            result = await operations.use(
              required(parsed.args[0], "use requires an account or auto"),
            );
            break;
          case "refresh":
            result = await operations.refresh(parsed.args[0]);
            break;
          case "prime": {
            const spendConfirmed = await ctx.ui.confirm(
              "Prime untouched Codex account?",
              "This deliberately sends a minimal request and spends a small amount of quota.",
            );
            const rollingConfirmed = await ctx.ui.confirm(
              "Confirm rolling-window behavior",
              "Only continue if first use is known to start this account's weekly reset clock.",
            );
            if (!spendConfirmed || !rollingConfirmed) {
              ctx.ui.notify("Priming cancelled; no quota was spent.", "warning");
              return;
            }
            result = await operations.prime(parsed.args[0]);
            break;
          }
          case "policy":
            result = await operations.policy();
            break;
          case "reset":
            result = await operations.reset(
              required(parsed.args[0], "reset requires cooldowns, reservations, priming, or all"),
            );
            break;
          case "verify":
            result = await operations.verify();
            break;
          case "path":
            result = await operations.paths();
            break;
          case "log":
            result = await operations.log(parsed.args[0]);
            break;
        }
        ctx.ui.notify(result, "info");
      } catch (error) {
        ctx.ui.notify(
          error instanceof CommandParseError || error instanceof Error
            ? error.message
            : "Quota router command failed",
          "error",
        );
      }
    },
  });
}

export function formatQuotaRouterDashboard(status: string): string {
  return [
    status,
    "",
    "QUICK COMMANDS",
    "◆ /quota-router login [label]                 Add or reauthenticate an account",
    "◆ /quota-router list                          List managed accounts and auth state",
    "◆ /quota-router status                        Show current routing status",
    "◆ /quota-router use auto                      Enable quota-aware automatic routing",
    "◆ /quota-router refresh [account|all]         Refresh credentials and quota",
    "◆ /quota-router prime [account|all]           Send one confirmed minimal primer request",
    "",
    "MORE COMMANDS",
    "· /quota-router use <account>                 Force a managed account",
    "· /quota-router accounts                      Alias of list",
    "· /quota-router policy                        Show active routing policy",
    "· /quota-router reset <scope>                 Reset runtime state",
    "· /quota-router verify                        Validate files and permissions",
    "· /quota-router path                          Show router data paths",
    "· /quota-router log [on|off]                  Control diagnostic logging",
    "· /quota-router help                          Show this command guide",
  ].join("\n");
}

function required(value: string | undefined, message: string): string {
  if (!value) {
    throw new CommandParseError(message);
  }
  return value;
}
