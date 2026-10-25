import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

const root = fileURLToPath(new URL("../", import.meta.url))
const chart = "deploy/helm/genio-one"
const renderValues = [
  "--set", "secrets.existingSecret=render-test-existing",
  "--set", "bot.modelGatewayPublicHost=render-test.invalid",
  "--set", "runtimeReport.existingSecret=render-test-existing",
  "--set", "demo.archify.enabled=false",
]

function render(overrides = {}, { ce = true } = {}) {
  const args = ["template", "codex-upgrade", chart]
  if (ce) args.push("-f", `${chart}/values-ce.yaml`)
  else args.push("--set", "aiMcpGateway.enabled=false", "--set", "bot.mcpUrl=http://render-test.invalid/mcp")
  args.push(...renderValues, "-f", "-")
  const result = spawnSync(process.env.HELM_BIN || "helm", args, {
    cwd: root,
    input: JSON.stringify(overrides),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  assert.ifError(result.error)
  return result
}

function statefulSetReplicas(output, component) {
  const documents = output.split(/^---\s*$/m)
  const matches = documents.filter((document) =>
    document.includes(`# Source: genio-one/templates/${component}.yaml`)
    && /^kind: StatefulSet$/m.test(document))
  assert.equal(matches.length, 1, `one rendered ${component} StatefulSet`)
  const replicas = matches[0].match(/^  replicas: (\d+)$/m)
  assert.ok(replicas, `rendered ${component} StatefulSet has a numeric replica count`)
  return Number(replicas[1])
}

for (const ce of [false, true]) {
  test(`${ce ? "CE" : "default"} Helm values render one Bot writer`, () => {
    const result = render({}, { ce })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(statefulSetReplicas(result.stdout, "bot"), 1)
  })
}

for (const replicas of [0, 1]) {
  test(`Helm renders Bot replicas ${replicas}`, () => {
    const result = render({ bot: { replicas } })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(statefulSetReplicas(result.stdout, "bot"), replicas)
  })
}

for (const replicas of [2, -1, 0.5, true, null, "1"]) {
  test(`Helm rejects Bot replicas ${JSON.stringify(replicas)}`, () => {
    const result = render({ bot: { replicas } })
    assert.notEqual(result.status, 0, "invalid Bot replica count must fail Helm rendering")
    assert.match(result.stderr, /values don.t meet the specifications of the schema/i)
    assert.match(result.stderr, replicas === null
      ? /at '\/bot': missing property 'replicas'|bot: replicas is required/
      : /at '\/bot\/replicas':|bot\.replicas:/)
    assert.equal(result.stdout, "", "schema failure emits no Kubernetes manifests")
  })
}

test("Helm rejects multiple Bot writers even when Bot is disabled", () => {
  const result = render({ bot: { enabled: false, replicas: 2 } })
  assert.notEqual(result.status, 0, "disabled Bot must still reject multiple writers")
  assert.match(result.stderr, /values don.t meet the specifications of the schema/i)
  assert.match(result.stderr, /at '\/bot\/replicas':|bot\.replicas:/)
  assert.equal(result.stdout, "")
})

test("Helm accepts a disabled Bot with one replica", () => {
  const result = render({ bot: { enabled: false, replicas: 1 } })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /# Source: genio-one\/templates\/bot.yaml/)
})

test("Helm preserves unrelated values and permits two platform replicas", () => {
  const result = render({
    platform: { replicas: 2, renderTestUnknown: true },
    bot: { renderTestUnknown: { enabled: true } },
    renderTestUnknown: { replicas: 2 },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(statefulSetReplicas(result.stdout, "bot"), 1)
  assert.equal(statefulSetReplicas(result.stdout, "platform"), 2)
})
