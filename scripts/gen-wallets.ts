// Generates fresh TESTNET-ONLY wallets into .env. Keys are never printed; only addresses are.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"

const ROLES = ["DESK_KEY", "LEGAL_AID_KEY", "SPOOFER_KEY"] as const
const path = ".env"
const current = existsSync(path) ? readFileSync(path, "utf8") : ""
const lines = current.split(/\r?\n/).filter(Boolean)

for (const role of ROLES) {
  const index = lines.findIndex((l) => l.startsWith(`${role}=`))
  if (index === -1) lines.push(`${role}=${generatePrivateKey()}`)
  else if (!lines[index].slice(role.length + 1).trim()) lines[index] = `${role}=${generatePrivateKey()}`
  const line = lines.find((l) => l.startsWith(`${role}=`))!
  const address = privateKeyToAccount(line.slice(role.length + 1).trim() as `0x${string}`).address
  console.log(`${role.replace("_KEY", "").padEnd(10)} ${address}`)
}
if (!lines.some((l) => l.startsWith("ARKIV_ACCESS_KEY="))) lines.push("ARKIV_ACCESS_KEY=")
writeFileSync(path, lines.join("\n") + "\n")
