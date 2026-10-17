/**
 * Minimal structured logger. Emits one JSON object per event to stdout (picked
 * up by Workers Logs). Never log prompts, article bodies, tokens, or PII — only
 * ids, stage, attempt, latency, and a safe outcome/code.
 */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  try {
    console.log(JSON.stringify({ event, ...fields }));
  } catch {
    console.log(event);
  }
}
