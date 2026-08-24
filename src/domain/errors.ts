export class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

export class ConflictError extends RequestError {
  constructor(message: string, code?: string) {
    super(message, 409, code);
  }
}

export class NotFoundError extends RequestError {
  constructor(resource: string) {
    super(`${resource} tidak ditemukan`, 404);
  }
}
