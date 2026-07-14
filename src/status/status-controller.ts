import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { UsageSnapshot } from "../types.ts";

export interface StatusView {
  label: string;
  snapshot?: UsageSnapshot;
  urgency?: number;
  mode: string;
}

export function formatCompactStatus(view: StatusView & { now: number }): string {
  if (!view.snapshot) {
    return `Codex · ${view.label} · ${view.mode}`;
  }
  const shortRemaining =
    view.snapshot.shortWindow === undefined
      ? "n/a"
      : `${Math.max(0, Math.round(100 - view.snapshot.shortWindow.usedPercent))}%`;
  const weeklyRemaining =
    view.snapshot.weeklyWindow === undefined
      ? "?"
      : String(Math.max(0, Math.round(100 - view.snapshot.weeklyWindow.usedPercent)));
  const reset =
    view.snapshot.weeklyWindow?.resetsAt === undefined
      ? "?"
      : formatDuration(view.snapshot.weeklyWindow.resetsAt - view.now);
  const urgency = view.urgency === undefined ? "?" : view.urgency.toFixed(3);
  return `Codex · ${view.label} · 5h ${shortRemaining} · 7d ${weeklyRemaining}%/${reset} · urgent ${urgency}/h · ${view.mode}`;
}

export function createStatusController(options: {
  readCached: () => StatusView;
  clock: () => number;
}) {
  return {
    render(ui: ExtensionUIContext) {
      ui.setStatus(
        "quota-router",
        formatCompactStatus({ ...options.readCached(), now: options.clock() }),
      );
    },
  };
}

function formatDuration(milliseconds: number): string {
  if (milliseconds <= 0) {
    return "now";
  }
  const hours = Math.max(1, Math.round(milliseconds / 3_600_000));
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.round(hours / 24)}d`;
}
