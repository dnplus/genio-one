import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5188",
    permissions: ["microphone"],
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  },
  webServer: [{
    command: "pnpm exec vite --host 127.0.0.1 --port 5188 --strictPort",
    cwd: "../..",
    url: "http://127.0.0.1:5188/tests/voice-input/",
    reuseExistingServer: false,
  }, {
    command: "pnpm exec vite --host 127.0.0.1 --port 5198 --strictPort",
    cwd: "../../../platform",
    url: "http://127.0.0.1:5198/tests/public-models/",
    reuseExistingServer: false,
  }],
})
