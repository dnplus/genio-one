import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import type { CompiledAuthorizationBundle } from "@genioone/protocol/authorization"
import {
  validateProcessorPolicyBundle,
  type ProcessorPolicyBundle,
} from "../processor/contract"
import { createDurableEd25519Signer } from "../../../../apps/platform/platform-api/src/capabilities/gateway-projection/signer"
import { signGatewayReleaseCommand } from "../../../../apps/platform/platform-api/src/capabilities/runtime-control/gateway-release-integrity"
import {
  FilePolicyReleaseLoader,
  POLICY_RELEASE_FILES,
  isPolicyReleaseManifest,
  type PolicyReleaseLoaderOptions,
  type PolicyReleaseManifest,
} from "./policy-release"

const now = 1_800_000_000

function compactJws(payload: unknown, keyId: string, privateKey: KeyObject): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: keyId })).toString(
    "base64url",
  )
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = sign(null, Buffer.from(`${header}.${body}`), privateKey).toString(
    "base64url",
  )
  return `${header}.${body}.${signature}`
}

function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex")
}

interface ReleaseFixture {
  root: string
  releasesPath: string
  currentPointerPath: string
  lkgPointerPath: string
  rootKeyRingPath: string
  options: PolicyReleaseLoaderOptions
  manifest: PolicyReleaseManifest
  writeRelease(releaseId: string): Promise<string>
  writeRuntimeCommand(
    releaseId: string,
    overrides?: Partial<{
      gateway_id: string
      head_revision: number
      package_digest: string
      projection_count: number
    }>,
  ): Promise<void>
}

async function releaseFixture(): Promise<ReleaseFixture> {
  const root = await mkdtemp(join(tmpdir(), "genio-policy-release-"))
  const releasesPath = join(root, "releases")
  const currentPointerPath = join(root, "current")
  const lkgPointerPath = join(root, "lkg")
  const rootKeyRingPath = join(root, "release-root-keys.json")
  const runtimeCommandKeyRingPath = join(root, "runtime-command-keys.json")
  const rootKeys = generateKeyPairSync("ed25519")
  const runtimeCommandKeys = generateKeyPairSync("ed25519")
  const runtimeCommandSigner = createDurableEd25519Signer({
    privateKeyPem: runtimeCommandKeys.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    keyId: "runtime-command-1",
  })
  const enforcementKeys = generateKeyPairSync("ed25519")
  const rootKeyRing = {
    schema_version: 1 as const,
    keys: [
      {
        key_id: "release-root-1",
        public_key_pem: rootKeys.publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
      },
    ],
  }
  const enforcementKeyRing = {
    schema_version: 1 as const,
    keys: [
      {
        key_id: "enforcement-1",
        public_key_pem: enforcementKeys.publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
      },
    ],
  }
  const authorizationBundle: CompiledAuthorizationBundle = {
    schema_version: 1,
    tenant_id: "tenant-ai",
    revision: "policy-release-7",
    policy_version: "one-policy-4",
    issued_at: now - 30,
    expires_at: now + 300,
    rules: [
      {
        rule_id: "allow-corporate-gpt",
        disposition: "ALLOW",
        subject_ids: ["person-1"],
        acting_client_ids: ["codex"],
        resource_id: "corporate-gpt",
        capability_id: "chat",
        public_models: ["genio-standard"],
      },
    ],
  }
  const processorBundle: ProcessorPolicyBundle = {
    schema_version: 1,
    tenant_id: "tenant-ai",
    revision: authorizationBundle.revision,
    policy_version: authorizationBundle.policy_version,
    issued_at: authorizationBundle.issued_at,
    expires_at: authorizationBundle.expires_at,
    scopes: [
      {
        resource_id: "corporate-gpt",
        capability_id: "chat",
        steps: [
          {
            step_id: "protect-sensitive-data",
            hooks: {
              request: {
                action: "TOKENIZE",
                config: {
                  patterns: [{ name: "EMAIL", expression: "[^@\\s]+@[^@\\s]+" }],
                  token_ttl_seconds: 600,
                },
              },
              response: {
                action: "RESTORE",
                config: {
                  patterns: [],
                  token_ttl_seconds: 600,
                },
              },
            },
          },
        ],
      },
    ],
  }
  const authorizationJws = compactJws(
    authorizationBundle,
    "enforcement-1",
    enforcementKeys.privateKey,
  )
  const processorJws = compactJws(
    processorBundle,
    "enforcement-1",
    enforcementKeys.privateKey,
  )
  const gatewayRoutingArtifact = {
    schema_version: "genio.one.gateway-routing.v1",
    tenant_id: "tenant-ai",
    gateway_id: "gateway-ai",
    revision: authorizationBundle.revision,
    policy_version: authorizationBundle.policy_version,
    issued_at: authorizationBundle.issued_at,
    expires_at: authorizationBundle.expires_at,
    scopes: [],
  }
  const gatewayRoutingJws = compactJws(
    gatewayRoutingArtifact,
    "enforcement-1",
    enforcementKeys.privateKey,
  )
  const keyRingJson = `${JSON.stringify(enforcementKeyRing)}\n`
  const baseManifest: Omit<PolicyReleaseManifest, "release_id"> = {
    schema_version: 2,
    tenant_id: "tenant-ai",
    runtime_id: "gateway-runtime-1",
    gateway_id: "gateway-ai",
    issued_at: authorizationBundle.issued_at,
    expires_at: authorizationBundle.expires_at,
    authorization_bundle: {
      sha256: digest(authorizationJws),
      key_id: "enforcement-1",
      tenant_id: authorizationBundle.tenant_id,
      revision: authorizationBundle.revision,
      policy_version: authorizationBundle.policy_version,
      issued_at: authorizationBundle.issued_at,
      expires_at: authorizationBundle.expires_at,
    },
    processor_policy: {
      sha256: digest(processorJws),
      key_id: "enforcement-1",
      tenant_id: processorBundle.tenant_id,
      revision: processorBundle.revision,
      policy_version: processorBundle.policy_version,
      issued_at: processorBundle.issued_at,
      expires_at: processorBundle.expires_at,
    },
    gateway_routing_artifact: {
      sha256: digest(gatewayRoutingJws),
      key_id: "enforcement-1",
      tenant_id: gatewayRoutingArtifact.tenant_id,
      gateway_id: gatewayRoutingArtifact.gateway_id,
      revision: gatewayRoutingArtifact.revision,
      policy_version: gatewayRoutingArtifact.policy_version,
      issued_at: gatewayRoutingArtifact.issued_at,
      expires_at: gatewayRoutingArtifact.expires_at,
    },
    enforcement_verification_keys: {
      sha256: digest(keyRingJson),
      key_ids: ["enforcement-1"],
    },
    gateway_configuration: {
      capture_message_content: false,
    },
    gateway_projections: [
      {
        publication_id: "publication-corporate-gpt",
        projection_id: "projection-corporate-gpt",
        revision: 1,
        digest: "a".repeat(64),
      },
      {
        publication_id: "publication-engineering-mcp",
        projection_id: "projection-engineering-mcp",
        revision: 2,
        digest: "b".repeat(64),
      },
    ],
  }
  await mkdir(releasesPath, { recursive: true })
  await writeFile(rootKeyRingPath, `${JSON.stringify(rootKeyRing)}\n`)
  await writeFile(
    runtimeCommandKeyRingPath,
    `${JSON.stringify({
      schema_version: 1,
      keys: [
        {
          key_id: runtimeCommandSigner.keyId,
          public_key_pem: runtimeCommandSigner.publicKeyPem,
        },
      ],
    })}\n`,
  )

  let manifest = { ...baseManifest, release_id: "release-1" }
  const writeRuntimeCommand = async (
    releaseId: string,
    overrides: Partial<{
      gateway_id: string
      head_revision: number
      package_digest: string
      projection_count: number
    }> = {},
  ): Promise<void> => {
    const releasePath = join(releasesPath, releaseId)
    const headRevision = overrides.head_revision ?? Number.parseInt(
      releaseId.replace(/^release-/, ""),
      10,
    )
    const command = await signGatewayReleaseCommand({
      tenantId: "tenant-ai",
      runtimeId: "gateway-runtime-1",
      commandId: `command-${releaseId}`,
      release: {
        schema_version: "genio.one.gateway-release-ref.v1",
        release_id: releaseId,
        gateway_id: overrides.gateway_id ?? manifest.gateway_id,
        head_revision: headRevision,
        package_digest: overrides.package_digest ?? digest(releaseId),
        projection_count:
          overrides.projection_count ?? manifest.gateway_projections.length,
      },
      signer: runtimeCommandSigner,
    })
    await writeFile(
      join(releasePath, POLICY_RELEASE_FILES.runtimeCommand),
      JSON.stringify(command),
    )
  }
  const writeRelease = async (releaseId: string): Promise<string> => {
    manifest = { ...baseManifest, release_id: releaseId }
    const releasePath = join(releasesPath, releaseId)
    await mkdir(releasePath, { recursive: true })
    await writeRuntimeCommand(releaseId)
    await Promise.all([
      writeFile(join(releasePath, POLICY_RELEASE_FILES.authorizationBundle), authorizationJws),
      writeFile(join(releasePath, POLICY_RELEASE_FILES.processorPolicyBundle), processorJws),
      writeFile(join(releasePath, POLICY_RELEASE_FILES.gatewayRoutingArtifact), gatewayRoutingJws),
      writeFile(join(releasePath, POLICY_RELEASE_FILES.verificationKeyRing), keyRingJson),
      writeFile(
        join(releasePath, POLICY_RELEASE_FILES.manifest),
        compactJws(manifest, "release-root-1", rootKeys.privateKey),
      ),
    ])
    return releasePath
  }
  await writeRelease("release-1")
  await writeFile(currentPointerPath, "release-1\n")
  await writeFile(lkgPointerPath, "release-1\n")
  const options: PolicyReleaseLoaderOptions = {
    releasesPath,
    currentPointerPath,
    lastKnownGoodPointerPath: lkgPointerPath,
    releaseRootKeyRingPath: rootKeyRingPath,
    runtimeCommandKeyRingPath,
    target: {
      tenantId: "tenant-ai",
      runtimeId: "gateway-runtime-1",
      gatewayId: "gateway-ai",
    },
    now: () => now,
  }
  return {
    root,
    releasesPath,
    currentPointerPath,
    lkgPointerPath,
    rootKeyRingPath,
    options,
    get manifest() {
      return manifest
    },
    writeRelease,
    writeRuntimeCommand,
  }
}

test("loads one complete target-bound release with a closed projection set", async () => {
  const fixture = await releaseFixture()
  const release = await new FilePolicyReleaseLoader(fixture.options).current()
  assert.equal(release.releaseId, "release-1")
  assert.equal(release.source, "CURRENT")
  assert.deepEqual(release.releaseReference, {
    schema_version: "genio.one.gateway-release-ref.v1",
    release_id: "release-1",
    gateway_id: "gateway-ai",
    head_revision: 1,
    package_digest: digest("release-1"),
    projection_count: 2,
  })
  assert.equal(release.authorizationBundle.revision, "policy-release-7")
  assert.equal(release.processorPolicyBundle.scopes.length, 1)
  assert.equal(release.gatewayRoutingArtifact.scopes.length, 0)
  assert.deepEqual(
    release.manifest.gateway_projections.map((projection) => projection.publication_id),
    ["publication-corporate-gpt", "publication-engineering-mcp"],
  )
})

test("falls back to the externally promoted LKG without rewriting its pointer", async () => {
  const fixture = await releaseFixture()
  const badReleasePath = await fixture.writeRelease("release-2")
  await writeFile(
    join(badReleasePath, POLICY_RELEASE_FILES.processorPolicyBundle),
    "tampered",
  )
  await writeFile(fixture.currentPointerPath, "release-2\n")

  const release = await new FilePolicyReleaseLoader(fixture.options).current()
  assert.equal(release.releaseId, "release-1")
  assert.equal(release.source, "LKG")
  assert.equal(await readFile(fixture.lkgPointerPath, "utf8"), "release-1\n")
})

test("falls back when the signed gateway routing artifact is tampered", async () => {
  const fixture = await releaseFixture()
  const badReleasePath = await fixture.writeRelease("release-2")
  await writeFile(
    join(badReleasePath, POLICY_RELEASE_FILES.gatewayRoutingArtifact),
    "tampered",
  )
  await writeFile(fixture.currentPointerPath, "release-2\n")

  const release = await new FilePolicyReleaseLoader(fixture.options).current()
  assert.equal(release.releaseId, "release-1")
  assert.equal(release.source, "LKG")
})

test("rejects a release signed for another runtime target", async () => {
  const fixture = await releaseFixture()
  const loader = new FilePolicyReleaseLoader({
    ...fixture.options,
    target: { ...fixture.options.target, runtimeId: "gateway-runtime-2" },
  })
  await assert.rejects(loader.current(), /policy release target does not match runtime/)
})

test("rejects a signed runtime command that is not the manifest projection set", async () => {
  const fixture = await releaseFixture()
  await fixture.writeRuntimeCommand("release-1", { projection_count: 1 })

  await assert.rejects(
    new FilePolicyReleaseLoader(fixture.options).current(),
    /gateway release reference does not match manifest/,
  )
})

test("rejects unsigned head revision and package digest tampering", async () => {
  const fixture = await releaseFixture()
  const commandPath = join(
    fixture.releasesPath,
    "release-1",
    POLICY_RELEASE_FILES.runtimeCommand,
  )
  const command = JSON.parse(await readFile(commandPath, "utf8")) as Record<string, any>
  await writeFile(
    commandPath,
    JSON.stringify({
      ...command,
      revision: "2",
      desired_release: {
        ...command.desired_release,
        head_revision: 2,
        package_digest: "f".repeat(64),
      },
    }),
  )

  await assert.rejects(
    new FilePolicyReleaseLoader(fixture.options).current(),
    /Gateway runtime command digest does not match/,
  )
})

test("requires sorted unique projection and processor scope closed sets", async () => {
  const fixture = await releaseFixture()
  assert.equal(
    isPolicyReleaseManifest({
      ...fixture.manifest,
      gateway_projections: [...fixture.manifest.gateway_projections].reverse(),
    }),
    false,
  )
  assert.throws(
    () =>
      validateProcessorPolicyBundle({
        schema_version: 1,
        tenant_id: "tenant-ai",
        revision: "release-1",
        policy_version: "policy-1",
        issued_at: now - 1,
        expires_at: now + 1,
        scopes: [
          {
            resource_id: "corporate-gpt",
            capability_id: "chat",
            steps: [
              {
                step_id: "redact",
                hooks: { request: { action: "REDACT" } },
              },
            ],
          },
          {
            resource_id: "corporate-gpt",
            capability_id: "chat",
            steps: [
              {
                step_id: "redact",
                hooks: { request: { action: "REDACT" } },
              },
            ],
          },
        ],
      }),
    /duplicate scopes/,
  )
})
