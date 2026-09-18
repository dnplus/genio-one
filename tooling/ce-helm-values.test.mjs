import assert from "node:assert/strict"
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { defaultOutput, generateSecretValues, parseArgs, writeSecretValues } from "./ce-helm-values.mjs"

test("CE Helm values generator defaults outside the chart package", () => {
  assert.match(defaultOutput, /\/\.local\/ce-helm\/secrets\.yaml$/)
  assert.doesNotMatch(defaultOutput, /\/deploy\/helm\//)
  assert.deepEqual(parseArgs([]), { output: defaultOutput })
})

test("CE Helm values generator emits usable Ed25519 signing keys and matching key rings", () => {
  const { literals, runtimeReport } = generateSecretValues()
  for (const name of [
    "projectionSigningPrivateKeyPem",
    "runtimeCommandSigningPrivateKeyPem",
    "policyArtifactSigningPrivateKeyPem",
    "releaseRootSigningPrivateKeyPem",
    "enforcementPrivateKeyPem",
  ]) assert.equal(createPrivateKey(literals[name]).asymmetricKeyType, "ed25519")

  const runtimeKeys = JSON.parse(literals.runtimeCommandVerificationKeysJson)
  const releaseKeys = JSON.parse(literals.releaseRootVerificationKeysJson)
  const enforcementKeys = JSON.parse(literals.enforcementVerificationKeysJson)
  for (const [keySet, expectedId] of [
    [runtimeKeys, "runtime-command-key-1"],
    [releaseKeys, "release-root-key-1"],
    [enforcementKeys, "policy-artifact-key-1"],
  ]) {
    assert.equal(keySet.schema_version, 1)
    assert.equal(keySet.keys.length, 1)
    assert.equal(keySet.keys[0].key_id, expectedId)
    assert.equal(createPublicKey(keySet.keys[0].public_key_pem).asymmetricKeyType, "ed25519")
  }

  assert.equal(runtimeReport.generatedKeyId, "genio-one-bot-runtime-v1")
  const reportPrivate = createPrivateKey(literals.botRuntimeReportPrivateKeyPem)
  const reportPublic = createPublicKey(literals.botRuntimeReportPublicKeyPem)
  assert.equal(reportPrivate.asymmetricKeyType, "ed25519")
  assert.equal(reportPublic.asymmetricKeyType, "ed25519")
  const payload = Buffer.from("bot runtime report")
  assert.equal(verify(null, payload, reportPublic, sign(null, payload, reportPrivate)), true)
  assert.notEqual(literals.botRuntimeReportPrivateKeyPem, literals.runtimeCommandSigningPrivateKeyPem)
})

test("CE Helm values generator writes the required values with private permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "genio-one-ce-secrets-"))
  const output = join(directory, "generated-secrets.yaml")
  try {
    writeSecretValues(output)
    assert.equal(statSync(output).mode & 0o777, 0o600)
    const content = readFileSync(output, "utf8")
    for (const name of [
      "postgresPassword",
      "valkeyPassword",
      "mcpOAuthEncryptionKey",
      "projectionSigningPrivateKeyPem",
      "runtimeCommandVerificationKeysJson",
      "policyArtifactSigningPrivateKeyPem",
      "releaseRootVerificationKeysJson",
      "enforcementVerificationKeysJson",
      "downstreamCredentialsJson",
      "botRuntimeReportPrivateKeyPem",
      "botRuntimeReportPublicKeyPem",
    ]) assert.match(content, new RegExp(`^  ${name}:`, "m"))
    assert.match(content, /^runtimeReport:\n  generatedKeyId: "genio-one-bot-runtime-v1"$/m)
    assert.match(content, /BEGIN PRIVATE KEY/)
    assert.match(content, /key_id/)
    assert.match(content, /schema_version/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("CE Helm values generator refuses to overwrite an existing file", () => {
  const directory = mkdtempSync(join(tmpdir(), "genio-one-ce-secrets-"))
  const output = join(directory, "generated-secrets.yaml")
  try {
    writeFileSync(output, "preserve this file\n", { mode: 0o600 })
    assert.throws(() => writeSecretValues(output), /refusing to overwrite/)
    assert.equal(readFileSync(output, "utf8"), "preserve this file\n")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
