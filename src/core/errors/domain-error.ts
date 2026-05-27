/**
 * Base class for *expected* business errors raised inside use-cases.
 *
 * Examples:
 *   - `UserNotFoundError` — endpoint asked for a user that doesn't exist
 *   - `TrialAlreadyUsedError` — user tries to activate trial twice
 *   - `WebAccountConflictError` — login already taken
 *
 * Use-cases throw these instead of generic `Error` so the bot/api layer
 * can map `DomainError.code` to a localised message and decide whether
 * to show it to the user (`userFacing`) or log it internally only.
 *
 * Distinct from `UpstreamError` (network/auth failures from rezeis-admin),
 * which is treated as an infrastructure problem rather than business logic.
 */
export abstract class DomainError extends Error {
  /** Stable machine-readable identifier, e.g. `USER_NOT_FOUND`. */
  abstract readonly code: string;

  /**
   * When `true`, the bot/api layer is expected to render a friendly
   * message to the end user (typically by `t('error.<code>', lang)`).
   * When `false`, the error is internal — the user gets a generic
   * "something went wrong" and the operator sees the details via
   * EventReporter.
   */
  abstract readonly userFacing: boolean;

  public override toString(): string {
    return `${this.constructor.name}(${this.code}): ${this.message}`;
  }
}

export class UserNotFoundError extends DomainError {
  readonly code = 'USER_NOT_FOUND';
  readonly userFacing = true;
  public constructor(identifier: string) {
    super(`User not found: ${identifier}`);
  }
}

export class WebAccountConflictError extends DomainError {
  readonly code = 'WEB_ACCOUNT_CONFLICT';
  readonly userFacing = true;
  public constructor(reason: 'login_taken' | 'already_has_account') {
    super(`Web account conflict: ${reason}`);
  }
}

export class TrialIneligibleError extends DomainError {
  readonly code = 'TRIAL_INELIGIBLE';
  readonly userFacing = true;
  public constructor(public readonly reason: string) {
    super(`Trial ineligible: ${reason}`);
  }
}

export class InvalidInputError extends DomainError {
  readonly code = 'INVALID_INPUT';
  readonly userFacing = true;
  public constructor(field: string, hint?: string) {
    super(`Invalid input on ${field}${hint ? `: ${hint}` : ''}`);
  }
}
