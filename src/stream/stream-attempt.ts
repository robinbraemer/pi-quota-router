import type { FailureClass } from "../recovery/failure-classifier.ts";

export function canRotateBeforeOutput(failure: FailureClass): boolean {
  return (
    failure.kind === "quota" ||
    failure.kind === "auth-retry" ||
    failure.kind === "auth-invalid" ||
    failure.kind === "transient"
  );
}
