# Supply Setu — an open supply-chain record for India's essential goods

**Live:** <https://jawab-do.onrender.com> · built on **Arkiv, the Web3 database** (Tiramisu testnet, chain `7738577`) · MIT

> **Real:** official daily retail prices from the Department of Consumer Affairs (DoCA) Price Monitoring Division, <https://fcainfoweb.nic.in/Reports/DB/DBprices.aspx>.
> **Synthetic:** every company, licence, batch and trade is demo data (`demo = true`). No personal data is stored anywhere.

## The problem

Essential goods (dal, atta, oil, sugar, salt, milk, medicines) pass maker → distributor → retailer → customer. At every step the record is locked inside someone's own software, a WhatsApp photo of a bill, or a platform. So:

- **Fakes get in.** Nobody downstream can check where a box really came from. India publishes monthly lists of spurious and "Not of Standard Quality" medicines (CDSCO NSQ alerts).
- **Recalls don't reach the shelf.** There is no shared list of who holds which batch.
- **Prices hide.** The government publishes official daily prices for these exact goods, but nobody compares a trader's offer to them.
- **Small businesses are walled in.** Their trading history lives on someone else's platform.

## What Supply Setu does

| For | What they get |
|---|---|
| **Customer** | Type the batch number on the pack → origin, every hand it passed through, shelf life left, recall status, fair price vs today's govt price. |
| **Shop / distributor** | A marketplace where every offer shows its markup against the official price (e.g. *Tur dal ₹178.31 = +36% vs govt ₹131.11*), and stock they buy arrives with its full history. |
| **Maker** | Batches that can't be faked under their brand, and recalls that reach every holder instantly. |
| **Regulator** | A licence registry, live recalls, and queries like "all offers >20% above govt price" or "all batches made by unlicensed wallets". |
| **Any other app** | The same open records, readable straight from Arkiv without our server. |

## Why Arkiv, not Postgres

A normal database can draw these screens. What it can't give is a record that **no single company owns and that enforces its own rules**:

| Need | Postgres / a platform's API | Arkiv |
|---|---|---|
| Prove who made a batch | An admin can edit the "brand" column | `$creator` is set by the chain and can't be changed. A batch claiming "Annapurna" but created by another wallet is visibly counterfeit. |
| Know who holds the goods now | Each company's own table, never in sync | **Custody = `$owner`.** Selling stock transfers the batch record to the buyer in the same transaction. |
| Expired stock / stale offers / old prices | Rows stay until someone writes a cleanup job | **Entity Expiration**: a batch expires on its best-before date, an offer after 48 h, a price after 48 h, a licence after a year. Gone from every query, automatically. |
| History nobody can rewrite | Audit tables are editable by the operator | Each made/split/sold/recalled step is `readonly` and handed to the burn address in the same batch. |
| One shared record, no walled garden | Integrations and data exports per partner | Every app queries the same Arkiv entities with the same typed queries. |
| Recalls in real time | Polling, emails | `watchEntityEvents` over WebSocket pushes the recall to every open screen. |

**Deliberately off Arkiv:** private keys and the Hub access key (server env only); any real person or business data (none exists in the demo).

## How we use each Arkiv feature

| Feature | Where | What the user sees |
|---|---|---|
| Typed attributes vs payload | `price_paise`, `markup_bp`, `qty`, `best_before` are `u64`/`i32`; brand/sku/category/batch are `str`; links are `key`. Notes/raw govt rows go in the JSON payload. [`src/shared/setuOps.ts`](src/shared/setuOps.ts) | Filters by category/state, batch lookup, price comparisons |
| Numeric range queries | `markup_bp > i32(2000)` (overpriced), `<= i32(2000)` (fair) [`server/setu.ts`](server/setu.ts) | "Overpriced (>20% above govt)" filter, hero stat, browser verify button |
| `createdBy()` / `ownedBy()` | prices `createdBy(oracle)`, licences `createdBy(regulator)`, inventory `ownedBy(wallet)` | Only official prices shown; each role's stock |
| `$creator` trust | counterfeit check walks the batch's split chain and requires licensed creators + root creator = product maker | ✔ Genuine / ⚠ Counterfeit badges with reasons |
| `$owner` + `changeOwnership` | `fillOffer`: whole lot → buyer, or split child → buyer | "Held by …" moves when you click Buy |
| Atomic `executeBatch` + `predictEntityKeys` | make = lot + move; buy = child lot + patch parent qty + move + delete offer + 2 ownership changes | One click = one transaction; stock and history never half-update |
| Entity Expiration per type | lot = best-before, offer 48 h, price 48 h, licence 365 d, product 365 d, move 365 d, recall 180 d | "Record expires in N days"; expired stock simply disappears |
| Creation flags | moves `readonly + permissionlessExtension`; products `permissionlessExtension` | Burn-owned, uneditable journey |
| WebSocket events | browser `watchEntityEvents` with `webSocket()`, no `fromBlock` [`src/web/main.ts`](src/web/main.ts) | Live feed + red recall toast |
| Pagination | marketplace `.cursor()` | "Load more" |

Full data contract: [`arkiv/schema.md`](arkiv/schema.md). Friction log: [`arkiv/friction.md`](arkiv/friction.md).

## Wallets (Tiramisu)

| Role | Address |
|---|---|
| Price oracle (posts DoCA prices) | `0xBdCFa186015be08C849399e754d998100cd09fCC` |
| Regulator (licences, recalls) | `0x3E4769d8f0dB51286b468ff015d7540D2F93043c` |
| Maker · Annapurna Foods (demo) | `0xAF8C928d6413b6fC902acfc0A7c37928C703930C` |
| Maker · Jeevan Pharma (demo) | `0x2b4a7618AffDabdE7E4F8b83dB37eB3dbC7Ae409` |
| Distributor · Patna (demo) | `0xBE1e9E82c6e624e421b5EeC2447D605e32f2c734` |
| Retailer · Patna (demo) | `0xC24479CC53aA4D889E1a682a95548049be5208DB` |
| Counterfeiter (unlicensed, demo) | `0x606cA9dc71cd8F2b4a49fae9586949e004C0aB58` |

Explorer: <https://tiramisu.explorer.arkiv.network>

## Reproduce

**In the browser (no install):** open the live app → *Trace* `ANN-TUR1-B2611` (one counterfeit, several genuine) → *Marketplace* filter "Overpriced" → *Verify without us* runs the same query straight from your browser to the public Arkiv RPC.

**From a terminal (no keys, no server):**
```bash
git clone https://github.com/shivamKumarG11/jawab-do.git && cd jawab-do
npm ci
npm run verify     # official prices, licence registry, counterfeit batches, overpriced offers — straight from Arkiv
```

**Run your own copy:** Node 22.20+.
```bash
npm ci && npm test && npm run build
npx tsx scripts/gen-wallets.ts   # writes testnet keys to .env, prints addresses only
# fund each address at https://hub.arkiv.network/faucet; optional Hub key → ARKIV_ACCESS_KEY
# put your new addresses in src/shared/setu.ts ROLES (the canonical demo uses the table above)
npm run seed      # real DoCA prices + synthetic chain
npm start         # http://localhost:8080 (re-posts DoCA prices every 3 h)
```
Optional: `DATA_GOV_IN_KEY` (free at data.gov.in) adds live Agmarknet mandi prices.

## Limits (honest)

- Demo relay: the server signs as each demo role (12 writes / 10 min per visitor, 400/day). In production each business signs with its own wallet.
- Counterfeit detection proves *who created the record*, not what is physically in the box. Medicines have no machine-readable govt price feed; the recall is modelled on CDSCO NSQ alerts.
- Render free tier sleeps after 15 min idle (first load ~1 min); a GitHub Action pings it every 10 min until 24 Oct.

Pre-existing work: none. This repo began on 18 Oct 2026 as "Jawab Do" (RTI deadline demo, baseline `c83265202b859d3759369c474eb455d3f573a7c5`) and pivoted to Supply Setu the same day; history is preserved.
