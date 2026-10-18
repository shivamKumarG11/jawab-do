import { defineConfig, loadEnv, type Plugin } from "vite"

// Dev only: mount the same API handler the production server uses.
const api = (): Plugin => ({
  name: "jawab-do-api",
  configureServer(server) {
    Object.assign(process.env, loadEnv("development", process.cwd(), ""))
    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith("/api/")) return next()
      const { handle } = await server.ssrLoadModule("/server/handler.ts")
      await handle(req, res)
    })
  },
})

export default defineConfig({
  plugins: [api()],
  build: { outDir: "dist", target: "es2022" },
})
