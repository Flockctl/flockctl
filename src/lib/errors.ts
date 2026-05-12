export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: number | string) {
    super(404, id !== undefined ? `${resource} #${id} not found` : `${resource} not found`);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, string[]>) {
    super(422, message, details);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, message, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, message, details);
  }
}

/**
 * 403 — the request was authenticated and well-formed but the caller
 * does not have permission to access the resource. Distinct from
 * ValidationError (422 = bad input shape) and from the implicit 401
 * returned by the auth middleware (no/wrong bearer token).
 *
 * Used by /fs/* (browse/read/write) where the path-jail or
 * loopback-only gate refuses an otherwise-valid request, and by
 * places that distinguish "you can't do that" from "that doesn't
 * exist" (e.g. permission_mode mismatch).
 */
export class ForbiddenError extends AppError {
  constructor(message: string, details?: unknown) {
    super(403, message, details);
  }
}
