export type FailureClass =
  | { kind: "quota"; retryAt?: number }
  | { kind: "auth-retry" }
  | { kind: "auth-invalid" }
  | { kind: "transient"; retryAt: number }
  | { kind: "fatal" }
  | { kind: "aborted" };

export function classifyFailure(error: unknown, now: number): FailureClass {
  const errors = errorChain(error);
  const status = firstNumber(errors, "status") ?? firstNumber(errors, "statusCode");
  const codes = errors.map((value) => stringProperty(value, "code").toLowerCase());
  const names = errors.map((value) => stringProperty(value, "name").toLowerCase());
  const messages = errors.map((value) =>
    typeof value === "string"
      ? value.toLowerCase()
      : value instanceof Error
        ? value.message.toLowerCase()
        : "",
  );
  const hasCode = (...values: string[]) => codes.some((code) => values.includes(code));
  const hasName = (value: string) => names.includes(value);
  const hasMessage = (value: string) => messages.some((message) => message.includes(value));

  if (hasName("aborterror") || hasCode("abort_err", "aborted")) {
    return { kind: "aborted" };
  }
  if (hasName("accountneedsreautherror")) {
    return { kind: "auth-invalid" };
  }
  if (hasName("tokenrefreshtransienterror")) {
    return { kind: "transient", retryAt: now + 60_000 };
  }
  if (
    hasCode("invalid_grant", "token_revoked") ||
    hasMessage("invalid_grant") ||
    hasMessage("refresh token was revoked")
  ) {
    return { kind: "auth-invalid" };
  }
  if (status === 401 || hasMessage("401") || hasMessage("unauthorized")) {
    return { kind: "auth-retry" };
  }
  if (
    status === 429 ||
    codes.some((code) => code.includes("usage_limit") || code.includes("quota")) ||
    hasMessage("rate limit") ||
    hasMessage("usage limit") ||
    hasMessage("quota") ||
    hasMessage("too many requests")
  ) {
    const retryAt = firstNumber(errors, "retryAt");
    return retryAt === undefined ? { kind: "quota" } : { kind: "quota", retryAt };
  }
  if (
    hasCode(
      "etimedout",
      "econnreset",
      "econnrefused",
      "enotfound",
      "enetwork",
      "eai_again",
      "und_err_connect_timeout",
      "und_err_headers_timeout",
      "und_err_body_timeout",
      "und_err_socket",
    ) ||
    hasName("timeouterror") ||
    hasMessage("fetch failed")
  ) {
    return { kind: "transient", retryAt: now + 60_000 };
  }
  return { kind: "fatal" };
}

function errorChain(error: unknown): unknown[] {
  const values: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    values.push(current);
    seen.add(current);
    current = objectProperty(current, "cause");
  }
  return values;
}

function firstNumber(values: unknown[], property: string): number | undefined {
  for (const value of values) {
    const result = numericProperty(value, property);
    if (result !== undefined) {
      return result;
    }
  }
  return undefined;
}

function objectProperty(value: unknown, property: string): unknown {
  if (typeof value !== "object" || value === null || !(property in value)) {
    return undefined;
  }
  return value[property as keyof typeof value];
}

function stringProperty(value: unknown, property: string): string {
  if (typeof value !== "object" || value === null || !(property in value)) {
    return "";
  }
  const result = value[property as keyof typeof value];
  return typeof result === "string" ? result : "";
}

function numericProperty(value: unknown, property: string): number | undefined {
  if (typeof value !== "object" || value === null || !(property in value)) {
    return undefined;
  }
  const result = value[property as keyof typeof value];
  return typeof result === "number" && Number.isFinite(result) ? result : undefined;
}
