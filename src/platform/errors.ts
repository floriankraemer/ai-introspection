/** The request is well-formed but cannot be applied (HTTP 422). Modules throw it; the HTTP layer maps it to a problem response. */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

/** The request conflicts with the current state, for example a missing prerequisite (HTTP 409). */
export class ConflictError extends Error {
  constructor(
    message: string,
    /** The actionable fix, shown apart from the reason (problem+json `fix`). */
    readonly fix?: string,
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** A paid operation was refused because the budget is used up (HTTP 429). `runAfter` says when it can succeed. */
export class BudgetExceededError extends Error {
  constructor(
    message: string,
    readonly runAfter: Date,
  ) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

/** The named thing does not exist (HTTP 404). */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
