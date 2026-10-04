import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TARGETS = [
  {
    resource: "envoyproxy",
    expectedKind: "EnvoyProxy",
    expectedApiVersion: "gateway.envoyproxy.io/v1alpha1",
    nameVariable: "GATEWAY_ID",
  },
  {
    resource: "gatewayconfig",
    expectedKind: "GatewayConfig",
    expectedApiVersion: "aigateway.envoyproxy.io/v1beta1",
    nameVariable: "GATEWAY_CONFIG_ID",
  },
];

const MANAGED_BY_PATH = "/metadata/labels/app.kubernetes.io~1managed-by";

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function defaultRunKubectl(binary, args) {
  const result = await execFileAsync(binary, args, {
    encoding: "utf8",
    maxBuffer: 1_048_576,
  });
  return result.stdout;
}

function resourceMetadata(resource, target, expected) {
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    throw new Error(`${target.resource}/${expected.name} returned invalid JSON`);
  }
  const metadata = resource.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`${target.resource}/${expected.name} is missing metadata`);
  }
  if (resource.kind !== target.expectedKind || resource.apiVersion !== target.expectedApiVersion) {
    throw new Error(`${target.resource}/${expected.name} is not the expected Gateway resource`);
  }
  if (metadata.name !== expected.name || metadata.namespace !== expected.namespace) {
    throw new Error(`${target.resource}/${expected.name} identity does not match the requested resource`);
  }
  const annotations = metadata.annotations;
  if (
    annotations?.["meta.helm.sh/release-name"] !== expected.releaseName ||
    annotations?.["meta.helm.sh/release-namespace"] !== expected.namespace
  ) {
    throw new Error(`${target.resource}/${expected.name} is not owned by this Helm release`);
  }
  const managedBy = metadata.labels?.["app.kubernetes.io/managed-by"];
  if (!["genio-one-platform", "Helm"].includes(managedBy)) {
    throw new Error(`${target.resource}/${expected.name} has an unexpected managed-by label`);
  }
  if (typeof metadata.uid !== "string" || !metadata.uid || typeof metadata.resourceVersion !== "string" || !metadata.resourceVersion) {
    throw new Error(`${target.resource}/${expected.name} is missing its optimistic-concurrency metadata`);
  }
  return { metadata, managedBy };
}

export function migrationPatch(input) {
  const { metadata, releaseName, namespace, managedBy } = input;
  return JSON.stringify([
    { op: "test", path: "/metadata/uid", value: metadata.uid },
    { op: "test", path: "/metadata/resourceVersion", value: metadata.resourceVersion },
    { op: "test", path: "/metadata/annotations/meta.helm.sh~1release-name", value: releaseName },
    { op: "test", path: "/metadata/annotations/meta.helm.sh~1release-namespace", value: namespace },
    { op: "test", path: MANAGED_BY_PATH, value: managedBy },
    { op: "replace", path: MANAGED_BY_PATH, value: "Helm" },
  ]);
}

async function migrateTarget(target, expected, runKubectl) {
  const output = await runKubectl([
    "get",
    target.resource,
    expected.name,
    "--namespace",
    expected.namespace,
    "--ignore-not-found=true",
    "--output=json",
  ]);
  if (!output.trim()) return "MISSING";
  const resource = JSON.parse(output);
  const { metadata, managedBy } = resourceMetadata(resource, target, expected);
  if (managedBy === "Helm") return "ALREADY_MIGRATED";
  await runKubectl([
    "patch",
    target.resource,
    expected.name,
    "--namespace",
    expected.namespace,
    "--type=json",
    "--patch",
    migrationPatch({ metadata, releaseName: expected.releaseName, namespace: expected.namespace, managedBy }),
  ]);
  return "MIGRATED";
}

export async function reconcileGatewayOwnership(input = {}) {
  const environment = input.environment ?? process.env;
  const namespace = requiredEnvironment(environment, "POD_NAMESPACE");
  const releaseName = requiredEnvironment(environment, "HELM_RELEASE_NAME");
  const expected = {
    namespace,
    releaseName,
    gatewayId: requiredEnvironment(environment, "GATEWAY_ID"),
    gatewayConfigId: requiredEnvironment(environment, "GATEWAY_CONFIG_ID"),
  };
  const binary = input.binary ?? environment.GENIO_ONE_KUBECTL?.trim() ?? "kubectl";
  const runKubectl = input.runKubectl ?? ((args) => defaultRunKubectl(binary, args));
  const results = [];
  for (const target of TARGETS) {
    results.push({
      resource: target.resource,
      state: await migrateTarget(target, {
        namespace,
        releaseName,
        name: target.nameVariable === "GATEWAY_ID" ? expected.gatewayId : expected.gatewayConfigId,
      }, runKubectl),
    });
  }
  return results;
}

if (import.meta.main) {
  reconcileGatewayOwnership()
    .then((results) => {
      for (const result of results) console.log(`${result.resource}: ${result.state}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
