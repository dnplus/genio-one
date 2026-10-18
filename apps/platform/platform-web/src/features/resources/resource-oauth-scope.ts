import { GENIOONE_SCOPES, type GenioOneScope } from "@genioone/protocol/authorization-scopes"

export function platformResourceOAuthScope(kind: "API" | "A2A", operationMethods: readonly string[]): GenioOneScope {
  if (kind === "A2A") return GENIOONE_SCOPES.invoke
  return operationMethods.length > 0 && operationMethods.every(method => ["GET", "HEAD"].includes(method.toUpperCase()))
    ? GENIOONE_SCOPES.read
    : GENIOONE_SCOPES.write
}
