// Posts today's official government prices to Arkiv (idempotent per date). Run: npm run ingest
import { ingestPrices } from "../server/handler"
console.log(JSON.stringify(await ingestPrices(process.argv.includes("--force")), null, 2))
process.exit(0)
