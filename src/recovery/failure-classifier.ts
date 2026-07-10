export type FailureClass =
  | { kind: "quota"; retryAt?: number }
  | { kind: "auth-retry" }
  | { kind: "auth-invalid" }
  | { kind: "transient"; retryAt: number }
  | { kind: "fatal" }
  | { kind: "aborted" };

export function classifyFailure(error: unknown, now: number): FailureClass {
  const status = numericProperty(error, "status") ?? numericProperty(error, "statusCode");
  const code = stringProperty(error, "code").toLowerCase();
  const name = stringProperty(error, "name").toLowerCase();
  const message =
    typeof error === "string"
      ? error.toLowerCase()
      : error instanceof Error
        ? error.message.toLowerCase()
        : "";

  if (name === "aborterror" || code === "abort_err" || code === "aborted") {
    return { kind: "aborted" };
  }
  if (name === "accountneedsreautherror") {
    return { kind: "auth-invalid" };
  }
  if (name === "tokenrefreshtransienterror") {
    return { kind: "transient", retryAt: now + 60_000 };
  }
  if (
    code === "invalid_grant" ||
    code === "token_revoked" ||
    message.includes("invalid_grant") ||
    message.includes("refresh token was revoked")
  ) {
    return { kind: "auth-invalid" };
  }
  if (status === 401 || message.includes("401") || message.includes("unauthorized")) {
    return { kind: "auth-retry" };
  }
  if (
    status === 429 ||
    code.includes("usage_limit") ||
    code.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("usage limit") ||
    message.includes("quota") ||
    message.includes("too many requests")
  ) {
    const retryAt = numericProperty(error, "retryAt");
    return retryAt === undefined ? { kind: "quota" } : { kind: "quota", retryAt };
  }
  if (
    code === "etimedout" ||
    code === "econnreset" ||
    code === "enetwork" ||
    name === "timeouterror"
  ) {
    return { kind: "transient", retryAt: now + 60_000 };
  }
  return { kind: "fatal" };
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
