import assert from "node:assert/strict"
import test from "node:test"

import { PlatformApiError } from "../src/capabilities/errors"
import { createPostgresPublicationWorkflowStore } from "../src/capabilities/publications/postgres"
import type { ResourceRegistry } from "../src/capabilities/resources/module"
import type { SqlAdapter } from "../src/persistence/sql-adapter"

test("PostgreSQL publication store fails closed without runtime delivery", () => {
  assert.throws(
    () => createPostgresPublicationWorkflowStore({
      sql: {} as SqlAdapter,
      resources: {} as ResourceRegistry,
      gatewayPublicationDelivery: undefined as never,
    }),
    (error: unknown) =>
      error instanceof PlatformApiError &&
      error.code === "PUBLICATION_DELIVERY_REQUIRED" &&
      error.statusCode === 500,
  )
})
