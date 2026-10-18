// Production server: serves the built frontend (dist/) and the API from one Node process.
import { createReadStream, existsSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { extname, join, normalize } from "node:path"
import { handle } from "./handler"

const DIST = join(process.cwd(), "dist")
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
}

createServer((req, res) => {
  if (req.url?.startsWith("/api/")) return void handle(req, res)
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "")
  let file = join(DIST, path)
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html")
  res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream")
  if (file.includes(`${join("dist", "assets")}`)) res.setHeader("cache-control", "public, max-age=31536000, immutable")
  createReadStream(file).pipe(res)
}).listen(Number(process.env.PORT ?? 8080), () => console.log(`Jawab Do on :${process.env.PORT ?? 8080}`))
