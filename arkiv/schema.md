# Supply Setu data contract: `setu.v1`

Network: Arkiv Tiramisu testnet (chain `7738577`) · `@arkiv-network/sdk` 0.8.1 · viem 2.57.3.

Every entity carries `project = str("supply-setu")`, `schema = str("setu.v1")`, `type = str(<type>)`, `demo = bool(true)`. Money is integer **paise** (`u64`), quantities integer units (`u64`), times ms since epoch (`u64`), percentages basis points (`i32`). Anyone can build on these entities; a breaking change gets a new `schema` value.

**Real vs synthetic:** `price` entities hold real official prices (Department of Consumer Affairs, <https://fcainfoweb.nic.in/Reports/DB/DBprices.aspx>; optional Agmarknet via data.gov.in). Everything else (businesses, licences, products, batches, trades, recalls) is synthetic demo data. No personal data is stored, plain or hashed.

## Trust model

Trust comes from `$creator` (set by the chain, immutable), never from attributes anyone can copy.

| Role | Wallet | Trusted for |
|---|---|---|
| Price oracle | `0xBdCFa186015be08C849399e754d998100cd09fCC` | `price` (only oracle-created prices are shown) |
| Regulator | `0x3E4769d8f0dB51286b468ff015d7540D2F93043c` | `participant` (licence registry), `recall` |
| Maker · Annapurna Foods | `0xAF8C928d6413b6fC902acfc0A7c37928C703930C` | its `product`s and root `lot`s; recalls of its own batches |
| Maker · Jeevan Pharma | `0x2b4a7618AffDabdE7E4F8b83dB37eB3dbC7Ae409` | same |
| Distributor | `0xBE1e9E82c6e624e421b5EeC2447D605e32f2c734` | split lots / offers it creates |
| Retailer | `0xC24479CC53aA4D889E1a682a95548049be5208DB` | same |
| Counterfeiter (no licence) | `0x606cA9dc71cd8F2b4a49fae9586949e004C0aB58` | nothing; its records are flagged |

**Genuine batch** = (1) the batch's `$creator` has a live `participant` entry, (2) the referenced `product` was created by a licensed maker, (3) every lot up the `parent` chain was created by a licensed wallet, and (4) the root lot's `$creator` equals the product's `$creator`. `$owner` = who holds the goods now.

## Entity types

| type | Created by | Key attributes | Entity Expiration (why) |
|---|---|---|---|
| `price` | oracle | `source` str (`doca`/`agmarknet`), `commodity` str slug, `label`, `category`, `unit` str, `price_paise` u64, `date` str, `as_of` u64, `trend_1m_bp`/`trend_1y_bp` i32; mandi: `state`, `market`, `min_paise`, `max_paise` | **48 h**. A price is "today's"; stale prices vanish by themselves. Payload: source URL + raw govt row. |
| `participant` | regulator | `wallet` addr, `role` str, `name`, `licence` str, `state` | **Licence validity (365 d)**. A lapsed licence leaves the registry; that wallet's batches stop verifying. |
| `product` | maker | `brand`, `name`, `sku`, `category`, `commodity`, `unit` str, `mrp_paise` u64 | 365 d; `permissionlessExtension` |
| `lot` | maker (root) or holder (split) | `product` key, `root` key, `parent` key (splits only), `sku`, `brand`, `batch`, `category`, `commodity` str, `qty` u64, `unit`, `mfg_at`/`best_before` u64, `origin_state` | **Best-before date** (split children copy the parent's exact expiry block). Expired stock disappears from every query. **`$owner` = custody.** |
| `move` | the acting wallet | `lot` key, `root` key, `kind` str (`made`/`split`/`sold`/`recalled`), `from`/`to` addr, `qty` u64, `price_paise` u64, `at` u64 | 365 d. `readonly` + `permissionlessExtension`, transferred to burn `0x000000000000000000000000000000000000dEaD` **in the same batch**. |
| `offer` | lot holder | `lot`/`root` key, `sku`, `brand`, `category`, `commodity`, `state`, `seller_role` str, `seller` addr, `qty`/`unit_price_paise`/`ref_price_paise` u64, **`markup_bp` i32** | **48 h** (or the lot's best-before if sooner). Deleted when bought. |
| `recall` | regulator or the product's maker | `root` key, `sku`, `brand`, `batch`, `reason`, `severity` str, `at` u64 | 180 d |

## Writes (each one `executeBatch`, keys from `predictEntityKeys`)

| Action | Operations |
|---|---|
| Post prices | create N `price` (chunks of 20) |
| Make batch | create `lot` (root = its own predicted key) + create `move(made)` + move → burn |
| List offer | create `offer` with `ref_price_paise` = today's oracle price, `markup_bp` computed |
| Buy (whole lot) | create `move(sold)` + delete `offer` + move → burn + **lot → buyer** |
| Buy (part) | create child `lot` (same expiry block) + patch parent `qty` + create `move(sold)` + delete `offer` + move → burn + **child → buyer** |
| Split | N child lots + N moves + patch parent `qty` + N moves → burn |
| Recall | create `recall` + create `move(recalled)` + move → burn |
| Keep product alive | `extendEntity` +30 d (permissionless) |

## Queries the app runs (exact strings from `builder.toString()`)

```text
# Today's official prices (server/setu.ts pricesQuery)
project = str('supply-setu') AND type = str('price') AND source = str('doca') AND $creator = addr(0xBdCFa186015be08C849399e754d998100cd09fCC)

# Licence registry
project = str('supply-setu') AND type = str('participant') AND $creator = addr(0x3E4769d8f0dB51286b468ff015d7540D2F93043c)

# Marketplace: overpriced / fair (numeric range on markup_bp), optional category/state, cursor pagination
project = str('supply-setu') AND type = str('offer') AND markup_bp > i32(2000)
project = str('supply-setu') AND type = str('offer') AND category = str('pulses') AND markup_bp <= i32(2000)

# A wallet's stock (ownedBy)
project = str('supply-setu') AND type = str('lot') AND $owner = addr(0xBE1e9E82c6e624e421b5EeC2447D605e32f2c734)

# Customer trace by printed batch number, then the journey of its root batch
project = str('supply-setu') AND type = str('lot') AND batch = str('ANN-TUR1-B2611')
project = str('supply-setu') AND type = str('move') AND root = key(0x…)

# Recalls
project = str('supply-setu') AND type = str('recall')
```

Live updates: browser `watchEntityEvents` over `webSocket("wss://rpc.tiramisu.db-chain.testnet.arkiv.network")`, **no `fromBlock`**, filtered client-side on role addresses; a new regulator entity triggers a recall toast.

Verify without our server: `npm run verify` (scripts/verify.ts) or the in-browser "Verify without us" button.
