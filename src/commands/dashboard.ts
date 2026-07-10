const COMMAND_ROWS = [
  ["/quota-router login [label]", "Add or reauthenticate a Codex account"],
  ["/quota-router list", "List managed accounts and cached quota state"],
  ["/quota-router status", "Show the current routing status"],
  ["/quota-router use auto", "Return to quota-aware automatic routing"],
  ["/quota-router refresh [account|all]", "Refresh credentials and quota state"],
  ["/quota-router prime [account|all]", "Explicitly prime untouched accounts"],
] as const;

export function formatDashboard(status: string): string {
  return [
    status,
    "",
    "AVAILABLE COMMANDS",
    ...COMMAND_ROWS.map(([command, description]) => `> ${command}\n  ${description}`),
  ].join("\n");
}
