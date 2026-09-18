import assert from "node:assert/strict"
import test from "node:test"
import { buildPlan } from "./ce-build-images.mjs"

test("CE builds six local images and does not publish by default", () => {
  const plan = buildPlan([])
  assert.equal(plan.images.length, 6)
  assert.equal(plan.commands.length, 6)
  assert.ok(plan.commands.every((command) => command[0] === "docker" && command[1] === "build"))
  assert.ok(plan.images.some(({ image }) => image === "genio-one-installer:0.1.0-dev.1"))
  assert.ok(plan.images.some(({ image }) => image === "genio-one-archify:0.1.0-dev.1"))
})

test("registry publication requires explicit intent and Kind loading names its cluster", () => {
  assert.throws(() => buildPlan(["--push"]), /explicit --registry/)
  assert.throws(() => buildPlan(["--registry", "https://user:password@example.com"]), /without a URL/)
  assert.throws(() => buildPlan(["--load-kind", "--all"]), /Invalid/)
  const plan = buildPlan(["--registry", "registry.example.com/team", "--tag", "ce-test", "--load-kind", "ce-test", "--push"])
  assert.ok(plan.images.every(({ image }) => image.startsWith("registry.example.com/team/") && image.endsWith(":ce-test")))
  assert.equal(plan.commands.filter((command) => command[1] === "push").length, 6)
  assert.deepEqual(plan.commands[6].slice(0, 5), ["kind", "load", "docker-image", "--name", "ce-test"])
})
