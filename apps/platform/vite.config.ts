import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { viteSingleFile } from "vite-plugin-singlefile"

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    viteSingleFile(),
    {
      name: "genio-one-product-entrypoints",
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          const [pathname, query] = (request.url ?? "/").split("?", 2)
          if (pathname === "/" || pathname === "/self-service" || pathname === "/self-service/") {
            request.url = `/management.html${query ? `?${query}` : ""}`
          }
          next()
        })
      },
    },
    {
      name: "genio-one-clean-single-file-html",
      enforce: "post",
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type === "asset" && output.fileName.endsWith(".html") && typeof output.source === "string") {
            output.source = output.source.replace(/[\t ]+$/gm, "")
          }
        }
      },
    },
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./platform-web/src"),
    },
  },
  server: {
    watch: {
      usePolling: true,
      interval: 100,
    },
    proxy: {
      "/healthz": process.env.GENIO_ONE_PLATFORM_ORIGIN ?? "http://127.0.0.1:58082",
      "/v1": {
        target: process.env.GENIO_ONE_PLATFORM_ORIGIN ?? "http://127.0.0.1:58082",
        ws: true,
      },
    },
  },
  build: {
    outDir: "platform-api/dist/web",
    emptyOutDir: false,
    rollupOptions: {
      input: path.resolve(__dirname, "management.html"),
    },
  },
})
