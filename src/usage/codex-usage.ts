import type { UsageSnapshot, UsageWindow } from "../types.ts";
import { timeoutSignal } from "../util/abort.ts";
import { type Clock, systemClock } from "../util/clock.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_TIMEOUT_MS = 10_000;

export class CodexUsageParseError extends Error {
  override readonly name = "CodexUsageParseError";

  constructor() {
    super("The Codex usage response has an unsupported shape");
  }
}

export class CodexUsageHttpError extends Error {
  override readonly name = "CodexUsageHttpError";
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface FetchCodexUsageOptions {
  accessToken: string;
  accountId: string;
  managedAccountId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: FetchImplementation;
  clock?: Clock;
}

export function parseCodexUsage(
  body: unknown,
  observedAt: number,
  accountId: string,
): UsageSnapshot {
  const root = asRecord(body);
  const rateLimit = asRecord(root.rate_limit);
  const shortWindow = parseWindow(rateLimit.primary_window, true);
  const weeklyWindow = parseWindow(rateLimit.secondary_window, false);
  const planType = typeof root.plan_type === "string" ? root.plan_type : undefined;
  const credits = isRecord(root.credits) ? root.credits : undefined;
  const creditsRemaining =
    credits && typeof credits.balance === "number" && Number.isFinite(credits.balance)
      ? Math.max(0, credits.balance)
      : undefined;

  return {
    accountId,
    observedAt,
    shortWindow,
    ...(weeklyWindow ? { weeklyWindow } : {}),
    stale: false,
    ...(planType ? { planType } : {}),
    ...(creditsRemaining !== undefined ? { creditsRemaining } : {}),
  };
}

export async function fetchCodexUsage(options: FetchCodexUsageOptions): Promise<UsageSnapshot> {
  const signal = timeoutSignal(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(USAGE_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${options.accessToken}`,
        "ChatGPT-Account-Id": options.accountId,
      },
      signal,
    });
  } catch (_error) {
    if (options.signal?.aborted) {
      throw options.signal.reason;
    }
    throw new CodexUsageHttpError("The Codex usage request did not complete");
  }

  if (!response.ok) {
    throw new CodexUsageHttpError(
      `The Codex usage endpoint returned HTTP ${response.status}`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CodexUsageParseError();
  }
  return parseCodexUsage(body, (options.clock ?? systemClock)(), options.managedAccountId);
}

function parseWindow(value: unknown, required: true): UsageWindow;
function parseWindow(value: unknown, required: false): UsageWindow | undefined;
function parseWindow(value: unknown, required: boolean): UsageWindow | undefined {
  if (!isRecord(value)) {
    if (required) {
      throw new CodexUsageParseError();
    }
    return undefined;
  }
  const usedPercent = value.used_percent;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
    throw new CodexUsageParseError();
  }
  const resetsAt = normalizeReset(value.reset_at);
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function normalizeReset(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.trunc(value < 1_000_000_000_000 ? value * 1_000 : value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new CodexUsageParseError();
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
