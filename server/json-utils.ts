/**
 * Strip ```json fences that LLMs sometimes wrap around JSON responses.
 * Shared utility used by all pipeline stages and scanners.
 */
export function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  return trimmed;
}

/**
 * Safe JSON parse that strips fences first.
 */
export function safeJsonParse<T = unknown>(text: string): T {
  return JSON.parse(stripJsonFences(text));
}
