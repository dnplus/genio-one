import { Type } from "typebox"
import type { Static } from "typebox"

const ErrorText = Type.String({ minLength: 1 })

const PlatformApiViolationSchema = Type.Object({
  code: ErrorText,
  message: ErrorText,
  field: Type.Optional(ErrorText),
}, { additionalProperties: false })

/** Shared error envelope for every Management API capability. */
export const PlatformApiErrorResponseSchema = Type.Object({
  code: ErrorText,
  message: ErrorText,
  violations: Type.Array(PlatformApiViolationSchema),
}, { additionalProperties: false })

export type PlatformApiErrorResponse = Static<typeof PlatformApiErrorResponseSchema>

export interface PlatformApiViolation {
  code: string
  message: string
  field?: string
}

/**
 * Errors crossing a capability seam carry a stable transport code and status.
 * The HTTP adapters do not need to know how an implementation stores state.
 */
export class PlatformApiError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message = code,
    readonly violations: readonly PlatformApiViolation[] = [],
  ) {
    super(message)
    this.name = "PlatformApiError"
  }
}

export function isPlatformApiError(error: unknown): error is PlatformApiError {
  return error instanceof PlatformApiError
}
