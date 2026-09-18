export function isGenioSessionRejection(reason: string | undefined) {
  return reason === "GENIO_ONE_SESSION_REJECTED" || reason === "GENIO_ONE_SESSION_INVALID" || reason === "GENIO_ONE_SESSION_TOKEN_REQUIRED"
}
