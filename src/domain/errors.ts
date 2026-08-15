export class RequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class ConflictError extends RequestError {
  constructor(message: string) {
    super(message, 409);
  }
}

export class NotFoundError extends RequestError {
  constructor(resource: string) {
    super(`${resource} not found`, 404);
  }
}
