/**
 * Error classification for the queue pipeline. RetryableError marks a transient
 * fault (network, timeout, provider 429/5xx) that should be retried via the
 * Queue's redelivery + DLQ. Anything else is permanent: fail the run and ack.
 */
export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}

/** True if an HTTP status warrants a retry (rate limit / server errors). */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** Binding outages are infrastructure failures, not invalid source documents. */
export function isTransientFailure(error: unknown): boolean {
  if (error instanceof RetryableError) return true;
  if (!(error instanceof Error)) return false;
  if (["AbortError", "TimeoutError"].includes(error.name)) return true;
  return /(?:D1_ERROR|D1_EXEC_ERROR|D1_RESET|R2 (?:GET|PUT|HEAD|DELETE|LIST)|internal error|network connection lost|network error|socket hang up|temporarily unavailable|request timed out|service unavailable|database is (?:locked|busy))/i.test(error.message);
}

/** A live lease is contention, not a failed generation attempt. */
export class StageBusyError extends RetryableError {
  constructor(public readonly delaySeconds: number) { super("This step is already being processed"); }
}
