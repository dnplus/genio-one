# CE Helm deployment

The CE chart is exported at `deploy/helm/genio-one`. It is a source distribution, not a hosted release or image registry. Build the six chart images and publish them to a registry your cluster can pull from before installing.

## Prerequisites

You need a Kubernetes cluster, `kubectl`, Helm `v4.2.4`, registry push access, and cluster-administrator coordination for the Gateway API and Envoy AI Gateway CRDs. The CE profile does not install those cluster-scoped CRDs (`aiMcpGateway.installCrds: false`). It deploys single replicas, disables API management and Ingress, and leaves hostnames and TLS under your control.

The local-cluster validation reference is kind `v0.33.0` with node image `kindest/node:v1.36.4@sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed`, Helm `v4.2.4`, and kubectl `v1.36.4`. It is a reproducible test target, not a compatibility or production-readiness guarantee.

## Build and publish images

From the repository root, build all five images, tag them for your registry, and push them:

```sh
node tooling/ce-build-images.mjs \
  --registry registry.example.com/your-namespace \
  --tag ce-0.1.0 \
  --push
```

Use the image references printed by that command in an additional private values file for your installation. Do not assume that the example registry, tag, or any image name is published by the GenioOne project.

For a kind-based local cluster, create an isolated cluster and kubeconfig, then load the default chart tags. These commands use no registry and avoid a tag override that would differ from the chart defaults:

```sh
mkdir -p .local/ce-helm
kind create cluster \
  --name genio-ce-helm-20260914 \
  --image kindest/node:v1.36.4@sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed \
  --kubeconfig .local/ce-helm/kubeconfig
export KUBECONFIG="$PWD/.local/ce-helm/kubeconfig"
node tooling/ce-build-images.mjs --load-kind genio-ce-helm-20260914
```

## Create installation secrets

Generate a values file once per new installation. The generator refuses to overwrite an existing file, writes it with owner-only permissions, and never prints secret values.

```sh
node tooling/ce-helm-values.mjs
```

The default file is `.local/ce-helm/secrets.yaml`, which is ignored and stays outside the chart so Helm packaging cannot include it. Keep it in a secret manager or protected deployment workspace. It contains database passwords, signing keys, and client secrets. Regenerating it for an existing installation changes cryptographic material, so plan a credential and key rotation instead of replacing it in place.

Create `.local/ce-helm/values.yaml` for image references, public origins, DNS, TLS, and any storage settings required by the cluster. The `repository` and `tag` values must match the output of the image-build command; do not put secrets in this file.

```yaml
global:
  publicOrigin: "https://one.example.com"
  keycloakPublicOrigin: "https://identity.one.example.com"
  botPublicOrigin: "https://bot.one.example.com"
  imagePullSecrets:
    - name: registry-credentials
images:
  platform: { repository: registry.example.com/your-namespace/genio-one-platform-ts, tag: ce-0.1.0 }
  bot: { repository: registry.example.com/your-namespace/genio-one-bot, tag: ce-0.1.0 }
  archify: { repository: registry.example.com/your-namespace/genio-one-archify, tag: ce-0.1.0 }
  gateway: { repository: registry.example.com/your-namespace/genio-one-gateway, tag: ce-0.1.0 }
  gatewayServices: { repository: registry.example.com/your-namespace/genio-one-gateway-policy, tag: ce-0.1.0 }
  installer: { repository: registry.example.com/your-namespace/genio-one-installer, tag: ce-0.1.0 }
```

`global.imagePullSecrets` is applied to every GenioOne-authored Pod template. The CE profile also starts the private Archify renderer service for the demo path. Envoy dependency images are owned by their dependency charts; use `helm show values` for the bundled dependency when that registry also needs mirroring or credentials.

Create the referenced pull Secret in the `genio-one` namespace through your registry's approved credential process before installing the release.

## Install CRDs on a fresh cluster

Before rendering the main chart for the first time, have the cluster administrator install the bundled Gateway API/Envoy and Envoy AI Gateway CRDs. The main CE profile intentionally leaves `installCrds` false, and Kubernetes rejects custom resources if their CRDs do not yet exist. These commands use the chart's vendored dependency versions and work without downloading a chart.

```sh
mkdir -p .local/ce-helm
helm show crds deploy/helm/genio-one/charts/gateway-helm-v1.9.1.tgz \
  > .local/ce-helm/gateway-crds.yaml
kubectl apply --server-side -f .local/ce-helm/gateway-crds.yaml

helm template genio-one-ai-gateway-crds \
  deploy/helm/genio-one/charts/ai-gateway-crds-helm-v1.1.0.tgz \
  > .local/ce-helm/ai-gateway-crds.yaml
kubectl apply --server-side -f .local/ce-helm/ai-gateway-crds.yaml
```

Wait for the Gateway API CRDs, including `gatewayclasses`, `gateways`, and `httproutes`, and the six AI Gateway CRDs `aigatewayroutes`, `aiservicebackends`, `backendsecuritypolicies`, `gatewayconfigs`, `mcproutes`, and `quotapolicies` to become `Established`:

```sh
kubectl wait --for=condition=Established --timeout=5m \
  crd/gatewayclasses.gateway.networking.k8s.io \
  crd/gateways.gateway.networking.k8s.io \
  crd/httproutes.gateway.networking.k8s.io

kubectl wait --for=condition=Established --timeout=5m \
  crd/aigatewayroutes.aigateway.envoyproxy.io \
  crd/aiservicebackends.aigateway.envoyproxy.io \
  crd/backendsecuritypolicies.aigateway.envoyproxy.io \
  crd/gatewayconfigs.aigateway.envoyproxy.io \
  crd/mcproutes.aigateway.envoyproxy.io \
  crd/quotapolicies.aigateway.envoyproxy.io
```

For an existing cluster, its administrator owns CRD lifecycle: inspect the rendered CRDs and coordinate an upgrade instead of adding `--force-conflicts`.

## Render and install

Lint and render first, then install the CE base profile, your private cluster values, and the generated secrets:

```sh
helm lint deploy/helm/genio-one \
  -f deploy/helm/genio-one/values-ce.yaml \
  -f .local/ce-helm/values.yaml \
  -f .local/ce-helm/secrets.yaml

umask 077
helm template genio-one deploy/helm/genio-one \
  -n genio-one \
  -f deploy/helm/genio-one/values-ce.yaml \
  -f .local/ce-helm/values.yaml \
  -f .local/ce-helm/secrets.yaml \
  > .local/ce-helm/rendered.yaml

helm upgrade --install genio-one deploy/helm/genio-one \
  -n genio-one --create-namespace --skip-crds --wait --wait-for-jobs --timeout 15m \
  -f deploy/helm/genio-one/values-ce.yaml \
  -f .local/ce-helm/values.yaml \
  -f .local/ce-helm/secrets.yaml
```

Use `values-local.yaml` only for a local development cluster; it enables loopback HTTP origins and localhost publication verification. It uses the local chart image defaults, so it does not need the registry values file:

```sh
helm upgrade --install genio-one deploy/helm/genio-one \
  -n genio-one --create-namespace --skip-crds --wait --wait-for-jobs --timeout 15m \
  -f deploy/helm/genio-one/values-ce.yaml \
  -f deploy/helm/genio-one/values-local.yaml \
  -f .local/ce-helm/secrets.yaml
```

The local profile exposes ClusterIP services. Use these port forwards for its default local origins:

```sh
kubectl -n genio-one port-forward service/genio-one-genio-one-platform 5173:8080
kubectl -n genio-one port-forward service/genio-one-genio-one-keycloak 58080:8080
kubectl -n genio-one port-forward service/genio-one-genio-one-bot 5180:5181
kubectl -n genio-one port-forward service/genio-one-aigw-internal 1975:1975
```

## First Management login

The post-install Job bootstraps the Tenant Administrator and the chart-managed Gateway Runtime. Wait for the `genio-one-genio-one-post-install-*` Job to complete, then open http://127.0.0.1:5173/management. The default administrator username is `admin` unless you set `tenant.administratorUsername` in your values.

Read the generated administrator password only from the protected local values file; it is the `tenantAdministratorPassword` value. For example, open it locally with:

```sh
less .local/ce-helm/secrets.yaml
```

Enter the password directly in the sign-in form. Do not copy it into shell commands, environment variables, source files, or terminal history. After sign-in, open **Runtimes** and confirm that the chart-managed Runtime registration is valid and its control channel is connected. Before the first Resource is published, health and reconciliation can correctly show that they are waiting for a report because no release exists yet. Do not run the standalone local Gateway bootstrap flow for a Helm installation; wait for `READY` only after the first publication creates a Gateway revision.

## Verify the deployment

Wait for the workloads, inspect events, then use your configured public origins to sign in and perform the [first governed MCP request](first-mcp-request.md):

```sh
kubectl -n genio-one get pods
kubectl -n genio-one get events --sort-by=.lastTimestamp
kubectl -n genio-one get services
```

A successful Helm render or ready Pod alone does not prove that a Gateway release can enforce traffic. Verify identity recovery, public DNS and TLS, Gateway Runtime `READY`, an active Entitlement, the OIDC-authenticated MCP call, and the resulting Activity and Audit evidence. Record those results in your own deployment acceptance evidence before treating the environment as production-ready.
