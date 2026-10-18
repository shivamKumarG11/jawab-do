// Generates fresh TESTNET-ONLY wallets into .env. Keys are never printed; only addresses are.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"

const ROLES = ["DESK_KEY", "LEGAL_AID_KEY", "SPOOFER_KEY"] as const
const path = ".env"
const current = existsSync(path) ? readFileSync(path, "utf8") : ""
const lines = current.split(/\r?\n/).filter(Boolean)

for (const role of ROLES) {
  let line = lines.find((l) => l.startsWith(`${role}=`))
  if (!line) {
    line = `${role}=${generatePrivateKey()}`
    lines.push(line)
  }
  const address = privateKeyToAccount(line.slice(role.length + 1) as `0x${string}`).address
  console.log(`${role.replace("_KEY", "").padEnd(10)} ${address}`)
}
if (!lines.some((l) => l.startsWith("ARKIV_ACCESS_KEY="))) lines.push("ARKIV_ACCESS_KEY=")
writeFileSync(path, lines.join("\n") + "\n")
