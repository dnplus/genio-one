import { generateKeyPairSync } from "node:crypto"

import {
  createRuntimePolicyResponseSigner,
  RUNTIME_POLICY_RESPONSE_KEY_ID_HEADER,
  RUNTIME_POLICY_RESPONSE_SIGNATURE_HEADER,
} from "../../../runtimes/gateway/services/shared/runtime-report-attestation"

const keys = generateKeyPairSync("ed25519")
const signer = createRuntimePolicyResponseSigner("platform-test-response", keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString())

export const runtimePolicyResponseVerificationKeys = {
  [signer.keyId]: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
}

export function signedRuntimePolicyReceipt(request: Record<string, unknown>, receipt: object, status = 201): Response {
  return Response.json(receipt, { status, headers: {
    [RUNTIME_POLICY_RESPONSE_KEY_ID_HEADER]: signer.keyId,
    [RUNTIME_POLICY_RESPONSE_SIGNATURE_HEADER]: signer.sign({ kind: "REPORT_ACK", tenantId: String(request.tenant_id), request, response: receipt }),
  } })
}

export function signedRuntimePolicyDecision(request: Record<string, unknown>, nonce: string, decision: object): Response {
  return Response.json(decision, { headers: {
    [RUNTIME_POLICY_RESPONSE_KEY_ID_HEADER]: signer.keyId,
    [RUNTIME_POLICY_RESPONSE_SIGNATURE_HEADER]: signer.sign({ kind: "AUTHORIZE_RESPONSE", tenantId: String(request.tenant_id), nonce, request, response: decision }),
  } })
}
