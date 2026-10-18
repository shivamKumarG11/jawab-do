// Supply Setu domain: roles, categories, official-price mapping, view types. Shared by server, scripts and browser.
import type { Hex } from "viem"

export const PROJECT = "supply-setu"
export const SCHEMA = "setu.v1"
export const BURN = "0x000000000000000000000000000000000000dEaD" as const
export const CHAIN_ID = 7738577
export const EXPLORER = "https://tiramisu.explorer.arkiv.network"
export const WS_URL = "wss://rpc.tiramisu.db-chain.testnet.arkiv.network"
export const DOCA_URL = "https://fcainfoweb.nic.in/Reports/DB/DBprices.aspx"
export const AGMARKNET_RESOURCE = "9ef84268-d588-465a-a308-a864a43d0070"

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export const PRICE_LIFETIME = 48 * HOUR
export const OFFER_LIFETIME = 48 * HOUR
export const MOVE_LIFETIME = 365 * DAY
export const RECALL_LIFETIME = 180 * DAY
export const PRODUCT_LIFETIME = 365 * DAY
export const OVERPRICED_BP = 2000

export type Role = "oracle" | "regulator" | "maker" | "distributor" | "retailer" | "counterfeiter"
export type RoleId = "oracle" | "regulator" | "maker_food" | "maker_pharma" | "distributor" | "retailer" | "counterfeiter"

export const ROLES: Record<RoleId, { env: string; address: Hex; role: Role; name: string; state: string; licence?: string }> = {
  oracle: { env: "ORACLE_KEY", address: "0xBdCFa186015be08C849399e754d998100cd09fCC", role: "oracle", name: "Setu price oracle", state: "IN" },
  regulator: { env: "REGULATOR_KEY", address: "0x3E4769d8f0dB51286b468ff015d7540D2F93043c", role: "regulator", name: "Licensing authority (demo)", state: "IN" },
  maker_food: { env: "MAKER_FOOD_KEY", address: "0xAF8C928d6413b6fC902acfc0A7c37928C703930C", role: "maker", name: "Annapurna Foods (demo)", state: "MP", licence: "FSSAI-DEMO-10021" },
  maker_pharma: { env: "MAKER_PHARMA_KEY", address: "0x2b4a7618AffDabdE7E4F8b83dB37eB3dbC7Ae409", role: "maker", name: "Jeevan Pharma (demo)", state: "GJ", licence: "DL-DEMO-GJ-4410" },
  distributor: { env: "DISTRIBUTOR_KEY", address: "0xBE1e9E82c6e624e421b5EeC2447D605e32f2c734", role: "distributor", name: "Setu Distributors, Patna (demo)", state: "BR", licence: "FSSAI-DEMO-20877" },
  retailer: { env: "RETAILER_KEY", address: "0xC24479CC53aA4D889E1a682a95548049be5208DB", role: "retailer", name: "Gupta Kirana & Chemist, Patna (demo)", state: "BR", licence: "FSSAI-DEMO-31502" },
  counterfeiter: { env: "SPOOFER_KEY", address: "0x606cA9dc71cd8F2b4a49fae9586949e004C0aB58", role: "counterfeiter", name: "Unlicensed seller", state: "BR" },
}
export const roleOf = (a: string) => (Object.entries(ROLES).find(([, r]) => r.address.toLowerCase() === a.toLowerCase())?.[0] as RoleId | undefined)
export const nameOf = (a: string) => {
  const id = roleOf(a)
  if (id) return ROLES[id].name
  if (a.toLowerCase() === BURN.toLowerCase()) return "nobody (burn address)"
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

export const CATEGORIES: Record<string, string> = {
  grains: "Grains & flour", pulses: "Pulses (dal)", "edible-oils": "Edible oils", vegetables: "Vegetables",
  dairy: "Dairy & eggs", "sugar-salt": "Sugar, gur & salt", beverages: "Tea", spices: "Spices", medicines: "Medicines",
}

// Official DoCA commodity names → slug + category.
const MAP: [RegExp, string, string][] = [
  [/^broken rice/i, "broken-rice", "grains"], [/^rice/i, "rice", "grains"], [/^wheat/i, "wheat", "grains"],
  [/^atta/i, "atta", "grains"], [/^maida/i, "maida", "grains"], [/^suji/i, "suji", "grains"], [/^bajra/i, "bajra", "grains"],
  [/^jowar/i, "jowar", "grains"], [/^ragi/i, "ragi", "grains"], [/^besan/i, "besan", "pulses"],
  [/^gram dal\(bharat/i, "gram-dal-bharat", "pulses"], [/^gram dal/i, "gram-dal", "pulses"], [/^tur(\/| |arhar|$)/i, "tur-dal", "pulses"], [/^turmeric/i, "turmeric", "spices"],
  [/^urad/i, "urad-dal", "pulses"], [/^moong/i, "moong-dal", "pulses"], [/^mas(o|oo)r/i, "masoor-dal", "pulses"],
  [/^sugar/i, "sugar", "sugar-salt"], [/^gur/i, "gur", "sugar-salt"], [/^salt/i, "salt", "sugar-salt"],
  [/^milk/i, "milk", "dairy"], [/^desi ghee/i, "ghee", "dairy"], [/^butter/i, "butter", "dairy"], [/^eggs?/i, "eggs", "dairy"],
  [/^groundnut oil/i, "groundnut-oil", "edible-oils"], [/^mustard oil/i, "mustard-oil", "edible-oils"],
  [/^vanaspati/i, "vanaspati", "edible-oils"], [/^soya oil/i, "soya-oil", "edible-oils"], [/^sunflower oil/i, "sunflower-oil", "edible-oils"],
  [/^palm oil/i, "palm-oil", "edible-oils"], [/^tea/i, "tea", "beverages"], [/^potato/i, "potato", "vegetables"],
  [/^onion/i, "onion", "vegetables"], [/^tomato/i, "tomato", "vegetables"], [/^brinjal/i, "brinjal", "vegetables"],
  [/^black pepper/i, "black-pepper", "spices"], [/^coriander/i, "coriander", "spices"],
]
export function classify(label: string): { slug: string; category: string } {
  for (const [re, slug, category] of MAP) if (re.test(label.trim())) return { slug, category }
  return { slug: label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40), category: "grains" }
}

export const rupees = (paise: number | bigint) => `₹${(Number(paise) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
export const markupBp = (unitPaise: number, refPaise: number) => (refPaise > 0 ? Math.round(((unitPaise - refPaise) * 10_000) / refPaise) : 0)

export type PriceView = {
  key: string; source: string; commodity: string; label: string; category: string; unit: string
  pricePaise: number; date: string; asOf: number; trend1mBp?: number; trend1yBp?: number; state?: string; market?: string
  expiresAt: string; creator: string; trusted: boolean
}
export type ParticipantView = { key: string; wallet: string; role: string; name: string; licence: string; state: string; expiresAt: string; expiresAtMs?: number }
export type ProductView = { key: string; brand: string; name: string; category: string; commodity: string; unit: string; mrpPaise: number; sku: string; creator: string }
export type LotView = {
  key: string; product: string; sku: string; brand: string; category: string; commodity: string; batch: string
  qty: number; unit: string; mfgAt: number; bestBefore: number; originState: string; root: string; parent?: string
  owner: string; creator: string; expiresAt: string; expiresAtMs?: number
  verdict?: { genuine: boolean; reasons: string[] }; recalled?: RecallView[]
}
export type MoveView = { key: string; lot: string; root: string; kind: string; from: string; to: string; qty: number; pricePaise: number; at: number; creator: string; owner: string; readonly: boolean }
export type OfferView = {
  key: string; lot: string; root: string; sku: string; brand: string; category: string; commodity: string; qty: number
  unitPricePaise: number; refPricePaise: number; markupBp: number; seller: string; sellerRole: string; state: string
  creator: string; expiresAt: string; expiresAtMs?: number; verdict?: { genuine: boolean; reasons: string[] }; recalled?: boolean
}
export type RecallView = { key: string; root: string; sku: string; brand: string; batch: string; reason: string; severity: string; at: number; creator: string; trusted: boolean }
