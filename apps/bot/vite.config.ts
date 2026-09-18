import { fileURLToPath, URL } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    watch: {
      ignored: ["**/.local/**"],
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5181",
        ws: true,
      },
      "/v1": {
        target: process.env.GENIO_ONE_PLATFORM_ORIGIN ?? "http://127.0.0.1:58082",
      },
    },
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
  },
})
