export function redact(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{3,}\b/g, "[REDACTED]")
    .replace(/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{16,}\b/gi, "[REDACTED]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, "[REDACTED]");
}

export function sanitizeDisplay(value: string, maximum = 80): string {
  const printable = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f ? character : " ";
  })
    .join("")
    .replaceAll(/\s+/g, " ")
    .trim();
  return Array.from(printable).slice(0, maximum).join("");
}
