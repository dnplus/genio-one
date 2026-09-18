import { SdkErrorCode, SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client"
import { test, expect } from "bun:test"
import { discoverMcpWithUserAuthorization } from "./mcp-discovery"

const observation = { protocol_version: "test", server_name: "connector", server_version: "1", tools: [] }
test("public tool discovery does not resolve a personal credential", async () => {
  let credentials = 0
  const result = await discoverMcpWithUserAuthorization({ endpoint: "https://mcp.test", credential: async () => { credentials++; return "token" }, discover: async () => observation })
  expect(result).toEqual(observation)
  expect(credentials).toBe(0)
})
test("protected tool discovery resolves user authorization only after 401", async () => {
  let calls = 0
  let credentials = 0
  const result = await discoverMcpWithUserAuthorization({ endpoint: "https://mcp.test", credential: async () => { credentials++; return "token" }, discover: async (input) => {
    calls++
    if (!input.authProvider) throw new UnauthorizedError("unauthorized")
    return observation
  } })
  expect(result).toEqual(observation)
  expect(calls).toBe(2)
  expect(credentials).toBe(1)
})
test("network failures are not retried with credentials", async () => {
  let credentials = 0
  await expect(discoverMcpWithUserAuthorization({ endpoint: "https://mcp.test", credential: async () => { credentials++; return "token" }, discover: async () => { throw new Error("network failure") } })).rejects.toThrow("network failure")
  expect(credentials).toBe(0)
})
test("SDK HTTP 401 resolves the OAuth credential and retries the same endpoint", async () => {
  let calls = 0
  let credentials = 0
  const endpoint = "https://mcp.notion.com/mcp"
  const result = await discoverMcpWithUserAuthorization({ endpoint, credential: async () => { credentials++; return "test-token" }, discover: async (input) => {
    calls++
    expect(input.endpoint).toBe(endpoint)
    if (!input.authProvider) throw new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "Missing or invalid access token", { status: 401 })
    expect(await input.authProvider.token()).toBe("test-token")
    return observation
  } })
  expect(result).toEqual(observation)
  expect(calls).toBe(2)
  expect(credentials).toBe(1)
})
test.each([403, 429, 500])("HTTP %i does not cause credential disclosure or retry", async (status) => {
  let credentials = 0
  const error = new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "HTTP failure", { status })
  await expect(discoverMcpWithUserAuthorization({ endpoint: "https://mcp.test", credential: async () => { credentials++; return "test-token" }, discover: async () => { throw error } })).rejects.toBe(error)
  expect(credentials).toBe(0)
})
