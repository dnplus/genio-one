import { describe, expect, test } from "bun:test"

import { proxiedDesktopUrl } from "./desktop-proxy"

describe("proxiedDesktopUrl", () => {
  test("keeps noVNC options and routes its websocket through the runtime session", () => {
    expect(proxiedDesktopUrl(
      "runtime-1",
      "https://6080-sandbox.e2b.example/vnc.html?autoconnect=true&resize=scale&password=secret",
    )).toBe(
      "/api/desktop/runtime-1/vnc.html?autoconnect=true&resize=scale&password=secret&path=%2Fapi%2Fdesktop%2Fruntime-1%2Fwebsockify",
    )
  })
})
