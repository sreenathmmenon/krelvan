/**
 * An operational condition the runtime can report without treating it as a
 * programmer or infrastructure failure.
 *
 * Expected errors are still loud in the ledger: the engine writes a signed
 * RunFailed event. `retryable` only controls automatic effect retries.
 */
export class ExpectedError extends Error {
  readonly expected = true;

  constructor(
    message: string,
    readonly code: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ExpectedError";
  }
}

export function isExpectedError(error: unknown): error is ExpectedError {
  return error instanceof ExpectedError;
}

export function isRetryableError(error: unknown): boolean {
  return !isExpectedError(error) || error.retryable;
}
