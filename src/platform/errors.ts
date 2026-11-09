/** The request is well-formed but cannot be applied (HTTP 422). Modules throw it; the HTTP layer maps it to a problem response. */
export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

/** The request conflicts with the current state, for example a missing prerequisite (HTTP 409). */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
