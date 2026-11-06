export class HttpError extends Error {
  constructor(status, message, { type = 'invalid_request_error', code = undefined } = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.type = type
    this.code = code
  }
}

export function openAIError(error) {
  return {
    error: {
      message: error.message,
      type: error.type || 'upstream_error',
      ...(error.code ? { code: error.code } : {}),
    },
  }
}

export function anthropicError(error) {
  return {
    type: 'error',
    error: {
      type: error.type || 'api_error',
      message: error.message,
    },
  }
}

export function responsesError(error) {
  return {
    error: {
      message: error.message,
      type: error.type || 'upstream_error',
      ...(error.code ? { code: error.code } : {}),
    },
  }
}
