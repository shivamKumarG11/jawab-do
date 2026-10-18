// RTI Act 2005 domain rules + synthetic directory. Shared by server, scripts and browser.
// Sections cited are checked against the official Act text (docs/india/rti-act-2005.pdf, cic.gov.in).

export const PROJECT = "jawab-do"
export const SCHEMA = "rti.v1"
export const BURN = "0x000000000000000000000000000000000000dEaD" as const
export const CHAIN_ID = 7738577
export const EXPLORER = "https://tiramisu.explorer.arkiv.network"
export const WS_URL = "wss://rpc.tiramisu.db-chain.testnet.arkiv.network"

const HOUR = 3_600_000
export const DAY = 24 * HOUR

export type Basis = "standard" | "life_liberty" | "via_apio" | "third_party"
export type Stage = "awaiting_reply" | "replied" | "first_appeal" | "second_appeal"
export type EventKind = "filed" | "replied" | "first_appeal" | "second_appeal" | "hearing" | "handed_over"

export const BASIS: Record<Basis, { label: string; ms: number; section: string }> = {
  standard: { label: "Standard (30 days)", ms: 30 * DAY, section: "s.7(1)" },
  life_liberty: { label: "Life or liberty (48 hours)", ms: 48 * HOUR, section: "s.7(1) proviso" },
  via_apio: { label: "Filed via Assistant PIO (35 days)", ms: 35 * DAY, section: "s.5(2)" },
  third_party: { label: "Third-party information (40 days)", ms: 40 * DAY, section: "s.11(3)" },
}

export const FIRST_APPEAL_WINDOW = 30 * DAY // s.19(1)
export const FAA_DECIDE = 30 * DAY // s.19(6)
export const FAA_DECIDE_MAX = 45 * DAY // s.19(6)
export const SECOND_APPEAL_WINDOW = 90 * DAY // s.19(3)
export const COMMISSION_LEASE = 90 * DAY // product rule: renewed by each hearing
export const EVENT_HORIZON = 365 * DAY // product rule: one-year public audit horizon

export const STAGES: Record<Stage, string> = {
  awaiting_reply: "Awaiting reply",
  replied: "Replied",
  first_appeal: "First appeal",
  second_appeal: "Second appeal (Information Commission)",
}

export const STATES: Record<string, string> = {
  BR: "Bihar", DL: "Delhi", KA: "Karnataka", MH: "Maharashtra",
  RJ: "Rajasthan", TN: "Tamil Nadu", UP: "Uttar Pradesh", WB: "West Bengal",
}

// Generic, non-branded department types (synthetic directory, demo only).
export const DEPARTMENTS: Record<string, { label: string; level: "state" | "central" }> = {
  collectorate: { label: "District Collectorate", level: "state" },
  municipal: { label: "Municipal Corporation", level: "state" },
  pwd: { label: "Public Works Department", level: "state" },
  food: { label: "Food & Civil Supplies Department", level: "state" },
  education: { label: "Education Department", level: "state" },
  rural: { label: "Rural Development Department", level: "state" },
  power: { label: "Electricity Distribution Office", level: "state" },
  railway: { label: "Regional Railway Office", level: "central" },
  pf: { label: "Regional Provident Fund Office", level: "central" },
}

export const CATEGORIES: Record<string, string> = {
  ration: "Ration card / PDS", pension: "Pension", roads: "Roads & works", scholarship: "Scholarship",
  land: "Land records", water: "Water supply", electricity: "Electricity", health: "Health services",
}

export const authorityId = (state: string, dept: string) => `${state.toLowerCase()}-${dept}`
export const authorityLabel = (id: string) => {
  const [st, dept] = [id.slice(0, 2).toUpperCase(), id.slice(3)]
  return `${DEPARTMENTS[dept]?.label ?? dept}, ${STATES[st] ?? st}`
}

export const dueAt = (filedAt: number, basis: Basis) => filedAt + BASIS[basis].ms

// Entity Expiration of a request = end of the citizen's legal remedy for its current stage (ms).
export const requestLifetimeEnd = {
  awaitingReply: (due: number) => due + FIRST_APPEAL_WINDOW,
  replied: (repliedAt: number) => repliedAt + FIRST_APPEAL_WINDOW,
  firstAppeal: (appealAt: number) => appealAt + FAA_DECIDE_MAX + SECOND_APPEAL_WINDOW,
  secondAppealLease: (now: number) => now + COMMISSION_LEASE,
}

export function newRef(state: string) {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  let s = ""
  for (let i = 0; i < 4; i++) s += a[Math.floor(Math.random() * a.length)]
  return `JD-${state}-${s}`
}

// Synthetic one-line topics per category (no personal data).
export const SUMMARIES: Record<string, string[]> = {
  ration: ["Status of pending ration card applications in the ward", "Stock register of the fair price shop for last quarter"],
  pension: ["Number of old-age pension applications pending over 90 days", "Disbursement dates of widow pension for the block"],
  roads: ["Sanctioned cost and completion date of the ward road repair", "Contractor work orders for drain construction this year"],
  scholarship: ["Post-matric scholarship release dates for the district", "Pending scholarship applications by college"],
  land: ["Time taken to process mutation applications", "Number of pending land record correction requests"],
  water: ["Water quality test reports for public taps in the ward", "Tanker supply schedule during summer months"],
  electricity: ["Pending new connection applications in the sub-division", "Transformer replacement complaints and resolution dates"],
  health: ["Medicine stock register of the primary health centre", "Staff sanctioned vs filled posts at the district hospital"],
}

export type RequestView = {
  key: string
  ref: string
  state: string
  authority: string
  level: string
  basis: Basis
  category: string
  stage: Stage
  filedAt: number
  dueAt: number
  appealBy?: number
  repliedAt?: number
  faaDueAt?: number
  summary?: string
  owner: string
  creator: string
  expiresAt: string
  expiresAtMs?: number
  permissionlessExtension: boolean
  trusted: boolean
}

export type EventView = {
  key: string
  kind: EventKind
  at: number
  note?: string
  owner: string
  creator: string
  expiresAt: string
  readonly: boolean
  trusted: boolean
}

export const isOverdue = (r: Pick<RequestView, "stage" | "dueAt">, now = Date.now()) =>
  r.stage === "awaiting_reply" && r.dueAt < now
