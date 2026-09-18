import { generateKeyPairSync } from "node:crypto"

import { PlatformApiError } from "../errors"
import type { RuntimeControlStore } from "../runtime-control/contract"
import type {
  GatewayBootstrapConfiguration,
  GatewayRegistration,
  GatewayRegistrationCreateInput,
  RegisterGatewayInput,
} from "./contract"

export interface GatewayRegistrationRepository {
  list(input: { tenantId: string }): Promise<GatewayRegistration[]>
  get(input: { tenantId: string; runtimeId: string }): Promise<GatewayRegistration | null>
  create(input: {
    tenantId: string
    actorSubjectId: string
    gatewayId: string
    value: GatewayRegistrationCreateInput
  }): Promise<GatewayRegistration>
  activate(input: { tenantId: string; runtimeId: string }): Promise<GatewayRegistration>
  retire(input: { tenantId: string; runtimeId: string }): Promise<GatewayRegistration>
}

export interface GatewayIdentityProvisioner {
  provision(input: {
    tenantId: string
    runtimeId: string
    clientId: string
  }): Promise<{
    issuer: string
    token_endpoint: string
    audience: string
    scope: string
    client_id: string
    client_secret: string
  }>
  revoke(input: { clientId: string }): Promise<void>
}

export interface GatewayRegistrationLifecycle {
  list(input: { tenantId: string }): Promise<GatewayRegistration[]>
  register(input: {
    tenantId: string
    actorSubjectId: string
    value: RegisterGatewayInput
  }): Promise<GatewayBootstrapConfiguration>
  provision(input: {
    tenantId: string
    actorSubjectId: string
    runtimeId: string
  }): Promise<GatewayBootstrapConfiguration>
  retire(input: {
    tenantId: string
    actorSubjectId: string
    runtimeId: string
  }): Promise<GatewayRegistration>
}

export function createGatewayRegistrationLifecycle(options: {
  repository: GatewayRegistrationRepository
  provisioner: GatewayIdentityProvisioner
  runtimeControl: RuntimeControlStore
  platformOrigin: string
  defaultGatewayId: string
  runtimeCommandVerificationKeys: GatewayBootstrapConfiguration["runtime_command_verification_keys"]
  policyReleaseRootKeys: GatewayBootstrapConfiguration["policy_release_root_keys"]
}): GatewayRegistrationLifecycle {
  const platformOrigin = options.platformOrigin.replace(/\/$/, "")

  async function provision(
    registration: GatewayRegistration,
  ): Promise<GatewayBootstrapConfiguration> {
    if (registration.state !== "PROVISIONING") {
      throw new PlatformApiError("GATEWAY_BOOTSTRAP_ALREADY_DELIVERED", 409)
    }
    const identity = await options.provisioner.provision({
      tenantId: registration.tenant_id,
      runtimeId: registration.runtime_id,
      clientId: registration.identity_client_id,
    })
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const reportKeyId = `${registration.runtime_id}-report`
    await options.runtimeControl.registerGatewayRuntime({
      tenantId: registration.tenant_id,
      runtimeId: registration.runtime_id,
      targetId: registration.gateway_id,
      oidcClientId: identity.client_id,
      reportKeyId,
      reportPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      status: "ACTIVE",
    })
    const active = await options.repository.activate({
      tenantId: registration.tenant_id,
      runtimeId: registration.runtime_id,
    })
    return {
      schema_version: "genio.one.gateway-bootstrap.v1",
      registration: active,
      platform_origin: platformOrigin,
      tenant_id: active.tenant_id,
      runtime_id: active.runtime_id,
      gateway_id: active.gateway_id,
      oidc: identity,
      report_signing: {
        key_id: reportKeyId,
        private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      },
      runtime_command_verification_keys: options.runtimeCommandVerificationKeys,
      policy_release_root_keys: options.policyReleaseRootKeys,
      credential_delivery: "ONE_TIME",
    }
  }

  return {
    list: options.repository.list,
    async register({ tenantId, actorSubjectId, value }) {
      const normalizedValue = {
        ...value,
        runtime_id: value.runtime_id?.trim() || `gateway-runtime-${crypto.randomUUID()}`,
      }
      const registration = await options.repository.create({
        tenantId,
        actorSubjectId,
        gatewayId: normalizedValue.gateway_id ?? options.defaultGatewayId,
        value: normalizedValue,
      })
      return provision(registration)
    },
    async provision({ tenantId, runtimeId }) {
      const registration = await options.repository.get({ tenantId, runtimeId })
      if (!registration) throw new PlatformApiError("GATEWAY_NOT_FOUND", 404)
      return provision(registration)
    },
    async retire({ tenantId, runtimeId }) {
      const registration = await options.repository.get({ tenantId, runtimeId })
      if (!registration) throw new PlatformApiError("GATEWAY_NOT_FOUND", 404)
      if (registration.state === "RETIRED") return registration
      await options.provisioner.revoke({ clientId: registration.identity_client_id })
      const runtime = await options.runtimeControl.getGatewayRuntime({ tenantId, runtimeId })
      if (runtime) {
        await options.runtimeControl.registerGatewayRuntime({
          tenantId,
          runtimeId,
          targetId: runtime.target_id,
          oidcClientId: runtime.oidc_client_id,
          reportKeyId: runtime.report_key_id,
          reportPublicKeyPem: runtime.report_public_key_pem,
          status: "REVOKED",
        })
      }
      return options.repository.retire({ tenantId, runtimeId })
    },
  }
}
