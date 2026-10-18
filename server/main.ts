// Production server: serves the built frontend (dist/) and the API from one Node process.
import { createReadStream, existsSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { handle } from "./handler"

const DIST = join(process.cwd(), "dist")
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
}

const port = Number(process.env.PORT ?? 8080)
const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/")) return void handle(req, res)
  let path: string
  try {
    path = decodeURIComponent((req.url ?? "/").split("?")[0])
  } catch {
    res.statusCode = 400
    res.end("Bad request")
    return
  }
  const file = resolve(DIST, `.${path}`)
  const fromDist = relative(DIST, file)
  if (isAbsolute(fromDist) || fromDist === ".." || fromDist.startsWith(`..${sep}`)) {
    res.statusCode = 404
    res.end("Not found")
    return
  }
  let target = file
  try {
    if (!existsSync(target) || statSync(target).isDirectory()) target = join(DIST, "index.html")
    if (!existsSync(target) || statSync(target).isDirectory()) {
      res.statusCode = 404
      res.end("Not found")
      return
    }
  } catch {
    res.statusCode = 500
    res.end("Server error")
    return
  }
  res.setHeader("content-type", TYPES[extname(target)] ?? "application/octet-stream")
  if (target.includes(`${join("dist", "assets")}`)) res.setHeader("cache-control", "public, max-age=31536000, immutable")
  const stream = createReadStream(target)
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (res.headersSent) return void res.destroy()
    res.statusCode = error.code === "ENOENT" ? 404 : 500
    res.end(error.code === "ENOENT" ? "Not found" : "Server error")
  })
  stream.pipe(res)
})
server.listen(port, "0.0.0.0", () => {
  const address = server.address()
  console.log(`Jawab Do on :${typeof address === "object" && address ? address.port : port}`)
})
