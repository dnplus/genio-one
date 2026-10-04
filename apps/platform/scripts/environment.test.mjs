import assert from "node:assert/strict";
import test from "node:test";

import { parseEnvironment } from "./environment.mjs";

test("environment parser preserves quoted spaces and structured values", () => {
  const environment = parseEnvironment(`
# Product-facing names require quotes when they contain spaces.
DISPLAY_NAME='Local Platform Admin'
KEYRING_JSON='{"schema_version":1,"keys":[{"key_id":"bundle key"}]}'
ORIGIN=http://127.0.0.1:58080
`);

  assert.equal(environment.DISPLAY_NAME, "Local Platform Admin");
  assert.deepEqual(JSON.parse(environment.KEYRING_JSON), {
    schema_version: 1,
    keys: [{ key_id: "bundle key" }],
  });
  assert.equal(environment.ORIGIN, "http://127.0.0.1:58080");
});

test("environment parser fails loudly on malformed quoted values", () => {
  assert.throws(
    () => parseEnvironment("DISPLAY_NAME='unterminated\nNEXT=value\n"),
    /unterminated/i,
  );
});
