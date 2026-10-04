import assert from "node:assert/strict";
import test from "node:test";

import { migrationPatch, reconcileGatewayOwnership } from "./gateway-runtime-ownership-migration.mjs";

const environment = {
  POD_NAMESPACE: "genio-one",
  HELM_RELEASE_NAME: "genio-one",
  GATEWAY_ID: "genio-ai-mcp-gateway",
  GATEWAY_CONFIG_ID: "genio-ai-mcp-gateway-config",
};

function resource(kind, apiVersion, name, managedBy = "genio-one-platform") {
  return {
    kind,
    apiVersion,
    metadata: {
      name,
      namespace: environment.POD_NAMESPACE,
      uid: `uid-${name}`,
      resourceVersion: "17",
      labels: { "app.kubernetes.io/managed-by": managedBy },
      annotations: {
        "meta.helm.sh/release-name": environment.HELM_RELEASE_NAME,
        "meta.helm.sh/release-namespace": environment.POD_NAMESPACE,
      },
    },
  };
}

function runner(resources, calls = []) {
  return async (args) => {
    calls.push(args);
    if (args[0] === "get") {
      const value = resources.get(args[2]);
      return value ? JSON.stringify(value) : "";
    }
    return "";
  };
}

test("migrates only release-owned Runtime labels with UID and resourceVersion CAS", async () => {
  const resources = new Map([
    [environment.GATEWAY_ID, resource("EnvoyProxy", "gateway.envoyproxy.io/v1alpha1", environment.GATEWAY_ID)],
    [environment.GATEWAY_CONFIG_ID, resource("GatewayConfig", "aigateway.envoyproxy.io/v1beta1", environment.GATEWAY_CONFIG_ID)],
  ]);
  const calls = [];
  const result = await reconcileGatewayOwnership({ environment, runKubectl: runner(resources, calls) });

  assert.deepEqual(result, [
    { resource: "envoyproxy", state: "MIGRATED" },
    { resource: "gatewayconfig", state: "MIGRATED" },
  ]);
  const patches = calls.filter((args) => args[0] === "patch");
  assert.equal(patches.length, 2);
  for (const args of patches) {
    assert.equal(args[5], "--type=json");
    const operations = JSON.parse(args[7]);
    assert.deepEqual(operations.slice(0, 5).map((operation) => operation.op), ["test", "test", "test", "test", "test"]);
    assert.deepEqual(operations.slice(0, 2).map((operation) => operation.path), ["/metadata/uid", "/metadata/resourceVersion"]);
    assert.equal(operations[5].op, "replace");
    assert.equal(operations[5].path, "/metadata/labels/app.kubernetes.io~1managed-by");
    assert.equal(operations[5].value, "Helm");
  }
});

test("skips missing or already migrated Gateway resources", async () => {
  const resources = new Map([
    [environment.GATEWAY_CONFIG_ID, resource("GatewayConfig", "aigateway.envoyproxy.io/v1beta1", environment.GATEWAY_CONFIG_ID, "Helm")],
  ]);
  const calls = [];
  const result = await reconcileGatewayOwnership({ environment, runKubectl: runner(resources, calls) });

  assert.deepEqual(result, [
    { resource: "envoyproxy", state: "MISSING" },
    { resource: "gatewayconfig", state: "ALREADY_MIGRATED" },
  ]);
  assert.equal(calls.filter((args) => args[0] === "patch").length, 0);
});

test("rejects a resource owned by another release", async () => {
  const foreign = resource("EnvoyProxy", "gateway.envoyproxy.io/v1alpha1", environment.GATEWAY_ID);
  foreign.metadata.annotations["meta.helm.sh/release-name"] = "other-release";
  const resources = new Map([[environment.GATEWAY_ID, foreign]]);

  await assert.rejects(
    () => reconcileGatewayOwnership({ environment, runKubectl: runner(resources) }),
    /not owned by this Helm release/,
  );
});

test("rejects an unexpected managed-by label", async () => {
  const resources = new Map([
    [environment.GATEWAY_ID, resource("EnvoyProxy", "gateway.envoyproxy.io/v1alpha1", environment.GATEWAY_ID, "someone-else")],
  ]);

  await assert.rejects(
    () => reconcileGatewayOwnership({ environment, runKubectl: runner(resources) }),
    /unexpected managed-by label/,
  );
});

test("does not swallow kubectl authorization or transport errors", async () => {
  await assert.rejects(
    () => reconcileGatewayOwnership({
      environment,
      runKubectl: async () => {
        throw new Error("forbidden");
      },
    }),
    /forbidden/,
  );
});

test("migrationPatch includes the guarded release identity", () => {
  const metadata = resource("EnvoyProxy", "gateway.envoyproxy.io/v1alpha1", environment.GATEWAY_ID).metadata;
  const operations = JSON.parse(migrationPatch({
    metadata,
    releaseName: environment.HELM_RELEASE_NAME,
    namespace: environment.POD_NAMESPACE,
    managedBy: "genio-one-platform",
  }));
  assert.deepEqual(operations.slice(2, 4), [
    { op: "test", path: "/metadata/annotations/meta.helm.sh~1release-name", value: "genio-one" },
    { op: "test", path: "/metadata/annotations/meta.helm.sh~1release-namespace", value: "genio-one" },
  ]);
});
