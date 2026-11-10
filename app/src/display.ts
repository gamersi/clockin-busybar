/**
 * True for the 409 the bar returns while a higher-priority app owns the screen.
 * busy-lib throws an Error carrying the HTTP `status` and the parsed `body`.
 */
export function isLowPriorityError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { status, code, message, body } = error as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
    body?: unknown;
  };
  const bodyRecord = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const is409 = status === 409 || code === 409 || bodyRecord.code === 409;
  const text = [message, bodyRecord.error, bodyRecord.message, typeof body === "string" ? body : ""]
    .map((part) => String(part ?? ""))
    .join(" ");
  return is409 && /low priority/i.test(text);
}
