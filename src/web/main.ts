import "./style.css"
import { createPublicClient } from "@arkiv-network/sdk"
import { i32, str } from "@arkiv-network/sdk/attr"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { eq, gt } from "@arkiv-network/sdk/query"
import { http, webSocket, type Hex } from "viem"
import { collectPages } from "../shared/pages"
import {
  BURN, CATEGORIES, OVERPRICED_BP, PROJECT, rupees, type LotView, type MoveView, type OfferView, type ParticipantView,
  type PriceView, type ProductView, type RecallView, type RoleId,
} from "../shared/setu"

type Role = { address: Hex; role: string; name: string; state: string; canWrite: boolean }
type Config = { explorer: string; wsUrl: string; usingAccessKey: boolean; mandi: boolean; docaUrl: string; roles: Record<RoleId, Role> }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const DAY = 86_400_000
let cfg: Config
const browserPub = createPublicClient({ chain: tiramisu, transport: http() })

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})
  const j = await r.json()
  if (!r.ok) throw new Error(j.error ?? r.statusText)
  return j as T
}
const addrLink = (a: string) => `<a href="${cfg.explorer}/address/${esc(a)}" target="_blank" rel="noopener">${esc(short(a))}</a>`
const txLink = (h: string) => `<a href="${cfg.explorer}/tx/${esc(h)}" target="_blank" rel="noopener">${esc(short(h))}</a>`
const roleEntry = (a: string) => Object.entries(cfg.roles).find(([, r]) => r.address.toLowerCase() === a.toLowerCase())
const who = (a: string) => {
  if (a.toLowerCase() === BURN.toLowerCase()) return `nobody (burn ${addrLink(a)})`
  const r = roleEntry(a)
  return r ? `<b>${esc(r[1].name)}</b> ${addrLink(a)}` : `unknown wallet ${addrLink(a)}`
}
const days = (ms: number) => { const d = Math.round(ms / DAY); return Math.abs(d) >= 1 ? `${d} days` : `${Math.max(0, Math.round(ms / 3_600_000))} h` }
const pct = (bp: number) => `${bp > 0 ? "+" : ""}${(bp / 100).toFixed(0)}%`
const catLabel = (c: string) => CATEGORIES[c] ?? c
const verdictBadge = (v?: { genuine: boolean }) => (v ? (v.genuine ? `<span class="tag ok-tag">✔ Genuine</span>` : `<span class="tag bad-tag">⚠ Counterfeit / unverified</span>`) : "")
const priceBadge = (o: { markupBp: number; refPricePaise: number }) =>
  !o.refPricePaise ? `<span class="tag">no govt price (medicine)</span>`
    : o.markupBp > OVERPRICED_BP ? `<span class="tag bad-tag">${pct(o.markupBp)} vs govt</span>`
    : `<span class="tag ok-tag">${pct(o.markupBp)} vs govt</span>`

// ---------- stats ----------
async function loadStats() {
  const s = await api<{ lots: number; genuine: number; counterfeit: number; offers: number; overpriced: number; recalls: number }>("/api/stats")
  $("statLots").textContent = String(s.lots); $("statGenuine").textContent = String(s.genuine); $("statFake").textContent = String(s.counterfeit)
  $("statOffers").textContent = String(s.offers); $("statOver").textContent = String(s.overpriced); $("statRecalls").textContent = String(s.recalls)
}

// ---------- official prices ----------
let prices: PriceView[] = []
async function loadPrices() {
  const r = await api<{ items: PriceView[]; query: string }>("/api/prices")
  prices = r.items
  $("priceQuery").textContent = r.query
  $("priceDate").textContent = prices[0] ? `· ${new Date(prices[0].date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : ""
  renderPrices()
  if (cfg.mandi) {
    const m = await api<{ items: PriceView[] }>("/api/prices?source=agmarknet")
    $("mandi").innerHTML = m.items.length ? `<h3>Wholesale mandi prices <small class="muted">Agmarknet via data.gov.in · ₹ per kg (modal)</small></h3><div class="price-grid">${m.items.slice(0, 18).map((p) => `<div class="price"><span>${esc(p.label)}</span><b>${rupees(p.pricePaise)}</b><small>${esc(p.state ?? "")} · ${esc(p.date)}</small></div>`).join("")}</div>` : ""
  }
}
function renderPrices() {
  const cat = $<HTMLSelectElement>("priceCat").value
  const list = prices.filter((p) => !cat || p.category === cat)
  $("priceGrid").innerHTML = list.length ? list.map((p) => {
    const t = p.trend1mBp ?? 0
    return `<div class="price"><span>${esc(p.label)}</span><b>${rupees(p.pricePaise)}<small> / ${esc(p.unit)}</small></b>
      <small class="${t > 300 ? "bad" : t < -300 ? "ok" : "muted"}">${t > 0 ? "▲" : t < 0 ? "▼" : "•"} ${pct(t)} in 1 month${p.trend1yBp !== undefined ? ` · ${pct(p.trend1yBp)} in 1 year` : ""}</small></div>`
  }).join("") : `<p class="muted">No official prices posted yet.</p>`
}

// ---------- marketplace ----------
let offerCursor: string | null = null
const offerCard = (o: OfferView) => `
  <article class="req ${o.verdict?.genuine === false ? "untrusted" : ""} ${o.recalled ? "recalled" : ""}">
    <div class="row between"><b>${esc(o.sku)}</b>${priceBadge(o)}</div>
    <div class="big">${esc(o.brand)} · ${esc(catLabel(o.category))}</div>
    <div class="row between price-line"><span><b class="money">${rupees(o.unitPricePaise)}</b> / unit</span>${o.refPricePaise ? `<span class="muted small">govt avg ${rupees(o.refPricePaise)}</span>` : ""}</div>
    <div class="small">${o.qty} units · seller ${who(o.seller)} · ${esc(o.state)}</div>
    <div class="row wrap gap">${verdictBadge(o.verdict)}${o.recalled ? `<span class="tag bad-tag">⛔ Recalled batch</span>` : ""}<span class="tag">offer ends in ${days((o.expiresAtMs ?? 0) - Date.now())}</span></div>
    ${o.verdict && !o.verdict.genuine ? `<div class="small badge-bad">${esc(o.verdict.reasons[0] ?? "")}</div>` : ""}
    <div class="row gap"><button data-buy="${esc(o.key)}" ${o.recalled ? "disabled" : ""}>Buy</button><button class="ghost" data-trace="${esc(o.lot)}">Trace</button></div>
  </article>`
async function loadOffers(append = false) {
  const p = new URLSearchParams()
  for (const [k, v] of new FormData($<HTMLFormElement>("offerFilters"))) if (v) p.set(k, String(v))
  if (append && offerCursor) p.set("cursor", offerCursor)
  try {
    const r = await api<{ items: OfferView[]; cursor: string | null; query: string }>(`/api/offers?${p}`)
    offerCursor = r.cursor; $("moreOffers").hidden = !r.cursor; $("offerQuery").textContent = r.query
    const html = r.items.map(offerCard).join("")
    if (append) $("offers").insertAdjacentHTML("beforeend", html); else $("offers").innerHTML = html || `<p class="muted">No live offers match.</p>`
  } catch (e) { $("offers").innerHTML = `<p class="bad">${esc((e as Error).message)}</p>` }
}

// ---------- trace ----------
function lotRow(l: LotView) {
  return `<article class="req ${l.verdict?.genuine === false ? "untrusted" : ""} ${l.recalled?.length ? "recalled" : ""}" data-trace="${esc(l.key)}">
    <div class="row between"><b>${esc(l.batch)}</b>${verdictBadge(l.verdict)}</div>
    <div class="big">${esc(l.brand)} · ${esc(l.sku)}</div>
    <div class="small">${l.qty} × ${esc(l.unit)} · held by ${who(l.owner)}</div>
    <div class="small muted">best before ${new Date(l.bestBefore).toLocaleDateString("en-IN")} · record expires in ${days((l.expiresAtMs ?? l.bestBefore) - Date.now())}</div>
    ${l.recalled?.length ? `<div class="small badge-bad">⛔ Recalled: ${esc(l.recalled[0].reason)}</div>` : ""}
  </article>`
}
async function find(text: string) {
  $("findOut").innerHTML = `<p class="muted">Searching Arkiv…</p>`
  try {
    const r = await api<{ items: LotView[]; query: string }>(`/api/find?q=${encodeURIComponent(text)}`)
    $("findOut").innerHTML = (r.items.map(lotRow).join("") || `<p class="muted">No live batch with that number. It may be expired, or never existed.</p>`) + `<details class="q"><summary>Exact Arkiv query</summary><pre>${esc(r.query)}</pre></details>`
  } catch (e) { $("findOut").innerHTML = `<p class="bad">${esc((e as Error).message)}</p>` }
}
const kindLabel: Record<string, string> = { made: "🏭 Made", split: "✂ Split", sold: "🤝 Sold", recalled: "⛔ Recalled", received: "📦 Received" }
async function openTrace(k: string) {
  const d = await api<{ lot: LotView; chain: LotView[]; moves: MoveView[]; recalls: RecallView[]; product?: ProductView; official?: PriceView; query: string }>(`/api/trace/${k}`)
  const l = d.lot
  const left = l.bestBefore - Date.now()
  $("detailBody").innerHTML = `
    <h2>${esc(l.brand)} <span class="muted small">${esc(d.product?.name ?? l.sku)}</span></h2>
    <div class="verdict ${l.verdict?.genuine ? "good" : "bad"}">${l.verdict?.genuine ? "✔ Genuine" : "⚠ Counterfeit / unverified"}<ul>${(l.verdict?.reasons ?? []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>
    ${d.recalls.length ? `<div class="verdict bad">⛔ Recalled ${d.recalls.map((r) => `<div>${esc(r.reason)} <small>(${r.trusted ? "by regulator/maker" : "UNTRUSTED recall notice"})</small></div>`).join("")}</div>` : ""}
    <table class="kv">
      <tr><td>Batch</td><td><b>${esc(l.batch)}</b> · ${l.qty} × ${esc(l.unit)}</td></tr>
      <tr><td>Shelf life</td><td>${left > 0 ? `${days(left)} left` : "expired"} (best before ${new Date(l.bestBefore).toLocaleDateString("en-IN")}). <span class="muted">Entity Expiration = best-before: the record leaves every query on that day.</span></td></tr>
      <tr><td>Fair price</td><td>${d.official ? `Govt average today: <b>${rupees(d.official.pricePaise)}</b> / ${esc(d.official.unit)} (DoCA ${esc(d.official.date)})` : "No official retail price for this item"}${d.product ? ` · MRP ${rupees(d.product.mrpPaise)}` : ""}</td></tr>
      <tr><td><code>$creator</code> (who started this record)</td><td>${who(l.creator)}</td></tr>
      <tr><td><code>$owner</code> (who holds it now)</td><td>${who(l.owner)}</td></tr>
      <tr><td>Split from</td><td>${d.chain.length ? d.chain.map((c) => `${esc(c.batch)} held by ${who(c.owner)}`).join(" ← ") : "original batch"}</td></tr>
      <tr><td>Record key</td><td><code class="small">${esc(l.key)}</code></td></tr>
    </table>
    <h3>Journey <small class="muted">readonly steps, burn-owned</small></h3>
    <ol class="timeline">${d.moves.map((m) => `<li><b>${kindLabel[m.kind] ?? esc(m.kind)}</b> · ${new Date(m.at).toLocaleString("en-IN")}
      ${m.kind === "sold" ? ` · ${m.qty} units ${who(m.from)} → ${who(m.to)} at ${rupees(m.pricePaise)}` : m.kind === "split" ? ` · ${m.qty} units` : m.kind === "made" ? ` · ${m.qty} units by ${who(m.from)}` : ` · by ${who(m.from)}`}
      <div class="small muted">step recorded by ${who(m.creator)} · owner ${who(m.owner)} · ${m.readonly ? "readonly" : "editable"}</div></li>`).join("")}</ol>
    <details class="q"><summary>Exact Arkiv query for this journey</summary><pre>${esc(d.query)}</pre></details>`
  const dlg = $<HTMLDialogElement>("detail")
  if (!dlg.open) dlg.showModal()
}

// ---------- recalls ----------
async function loadRecalls() {
  const r = await api<{ items: RecallView[] }>("/api/recalls")
  $("recallList").innerHTML = r.items.map((x) => `<li class="${x.trusted ? "" : "muted"}"><b>${esc(x.brand)} ${esc(x.batch)}</b> · ${esc(x.reason)}<br><small>${x.trusted ? "issued by" : "UNTRUSTED notice from"} ${who(x.creator)} · ${new Date(x.at).toLocaleString("en-IN")} · <a href="#" data-trace="${esc(x.root)}">trace batch</a></small></li>`).join("") || `<li class="muted">No active recalls.</li>`
}

// ---------- registry ----------
async function loadParticipants() {
  const r = await api<{ items: ParticipantView[]; query: string }>("/api/participants")
  $("participants").innerHTML = `<table><thead><tr><th>Business</th><th>Role</th><th>Licence</th><th>State</th><th>Licence record expires</th></tr></thead><tbody>${r.items.map((p) => `<tr><td>${who(p.wallet)}</td><td>${esc(p.role)}</td><td><code>${esc(p.licence)}</code></td><td>${esc(p.state)}</td><td>in ${days((p.expiresAtMs ?? 0) - Date.now())}</td></tr>`).join("")}</tbody></table>
    <p class="small muted">Not in this list: ${who(cfg.roles.counterfeiter.address)}, so anything it creates is flagged.</p><details class="q"><summary>Exact Arkiv query</summary><pre>${esc(r.query)}</pre></details>`
}

// ---------- act as ----------
const TABS: [RoleId, string][] = [["maker_food", "Maker · food"], ["maker_pharma", "Maker · pharma"], ["distributor", "Distributor"], ["retailer", "Retailer"], ["regulator", "Regulator"], ["counterfeiter", "Counterfeiter"]]
let activeRole: RoleId = "distributor"
let products: ProductView[] = []
const refPrice = (commodity: string) => prices.find((p) => p.commodity === commodity)?.pricePaise ?? 0

async function renderRole() {
  $("roleTabs").innerHTML = TABS.map(([id, label]) => `<button class="tab ${id === activeRole ? "on" : ""}" data-role="${id}">${label}</button>`).join("")
  const r = cfg.roles[activeRole]
  const head = `<p class="role-head">${who(r.address)} · ${esc(r.role)} · ${esc(r.state)}</p>`
  const panel = $("rolePanel")
  if (activeRole === "counterfeiter") {
    panel.innerHTML = head + `<p>This wallet has <b>no licence</b>. In the seed it copied the Annapurna Tur Dal product and batch number into its own record and offered it 30% below the govt price. The marketplace and trace view flag it because its <code>$creator</code> is not the brand's maker and not licensed. Try <a href="#" data-find="ANN-TUR1-B2611">tracing ANN-TUR1-B2611</a>.</p>`
    return
  }
  if (activeRole === "regulator") {
    const l = await api<{ items: LotView[] }>("/api/lots")
    const roots = l.items.filter((x) => !x.parent && !x.recalled?.length)
    panel.innerHTML = head + `<form id="recallForm" class="form"><label class="full">Batch to recall <select name="root">${roots.map((x) => `<option value="${esc(x.key)}">${esc(x.batch)} · ${esc(x.brand)} ${esc(x.sku)}</option>`).join("")}</select></label>
      <label class="full">Reason <input name="reason" value="Failed quality test: Not of Standard Quality (demo)" /></label><button>Issue recall to every holder</button></form>`
    return
  }
  const isMaker = activeRole.startsWith("maker")
  const [inv] = await Promise.all([api<{ items: LotView[]; query: string }>(`/api/lots?role=${activeRole}`), isMaker && !products.length ? api<{ items: ProductView[] }>("/api/products").then((p) => { products = p.items }) : undefined])
  const mine = products.filter((p) => p.creator.toLowerCase() === r.address.toLowerCase())
  panel.innerHTML = head + (isMaker ? `<form id="makeForm" class="form"><label class="full">Product <select name="product">${mine.map((p) => `<option value="${esc(p.key)}">${esc(p.brand)} ${esc(p.name)}</option>`).join("")}</select></label>
      <label>Quantity <input name="qty" type="number" min="1" value="500" /></label><label>Shelf life (days) <input name="shelfDays" type="number" min="1" value="180" /></label>
      <button>Make a new batch</button></form>` : "") +
    `<h3>Stock held by this wallet <small class="muted">ownedBy(${short(r.address)})</small></h3>
    <div class="list">${inv.items.map((l) => {
      const ref = refPrice(l.commodity)
      return `<article class="req ${l.recalled?.length ? "recalled" : ""}"><div class="row between"><b>${esc(l.batch)}</b>${verdictBadge(l.verdict)}</div>
        <div class="big">${esc(l.brand)} · ${esc(l.sku)}</div><div class="small">${l.qty} × ${esc(l.unit)} · best before ${new Date(l.bestBefore).toLocaleDateString("en-IN")}</div>
        ${l.recalled?.length ? `<div class="small badge-bad">⛔ Recalled: do not sell</div>` : ""}
        <form class="row wrap gap" data-offer="${esc(l.key)}"><input name="qty" type="number" min="1" max="${l.qty}" value="${Math.min(50, l.qty)}" title="units" /><input name="price" type="number" min="0.01" step="0.01" value="${ref ? (ref / 100).toFixed(2) : "30.00"}" title="₹ per unit" /><button ${l.recalled?.length ? "disabled" : ""}>List offer</button></form>
        <form class="row wrap gap" data-split="${esc(l.key)}"><input name="parts" value="${Math.max(1, Math.floor(l.qty / 4))},${Math.max(1, Math.floor(l.qty / 4))}" title="comma-separated parts" /><button class="ghost">Split</button><button type="button" class="ghost" data-trace="${esc(l.key)}">Trace</button></form>
        ${ref ? `<div class="small muted">govt avg ${rupees(ref)} per unit</div>` : ""}</article>`
    }).join("") || `<p class="muted">This wallet holds no live stock.</p>`}</div>`
}

async function act(fn: () => Promise<{ txHash?: string } & Record<string, unknown>>, btn?: HTMLButtonElement, out = "actOut") {
  if (btn) btn.disabled = true
  $(out).innerHTML = `<span class="muted">Sending one atomic transaction to Tiramisu…</span>`
  try {
    const r = await fn()
    $(out).innerHTML = `✔ Done in one transaction ${r.txHash ? txLink(r.txHash) : ""}`
    await Promise.allSettled([loadStats(), loadOffers(), loadRecalls(), renderRole()])
  } catch (e) { $(out).innerHTML = `<span class="bad">${esc((e as Error).message)}</span>` } finally { if (btn) btn.disabled = false }
}

// ---------- live feed ----------
function startFeed() {
  const ours = new Set(Object.values(cfg.roles).map((r) => r.address.toLowerCase()))
  const name = (a: string) => roleEntry(a)?.[1].name ?? short(a)
  const wsPub = createPublicClient({ chain: tiramisu, transport: webSocket(cfg.wsUrl) })
  const live = $("live")
  let got = false, err = false, timer: number | undefined
  wsPub.watchEntityEvents({
    onEvent: (e) => {
      got = true; live.textContent = "Live: WebSocket connected"; live.className = "live on"
      const parties = ["owner" in e ? e.owner : "", "previousOwner" in e ? e.previousOwner : "", "newOwner" in e ? e.newOwner : ""]
      const party = parties.find((p) => p && ours.has(p.toLowerCase()))
      if (!party) return
      const feed = $("feed"); if (feed.querySelector(".muted")) feed.innerHTML = ""
      const label = { EntityCreated: "created", EntityPatched: "updated", ExpiryExtended: "Lifetime Extension", OwnershipTransferred: "custody moved", EntityDeleted: "offer closed" }[e.type]
      const extra = e.type === "OwnershipTransferred" ? ` ${esc(name(e.previousOwner))} → ${esc(name(e.newOwner))}` : ` by ${esc(name(party))}`
      feed.insertAdjacentHTML("afterbegin", `<li><b>${label}</b>${extra} · ${txLink(e.transactionHash)}</li>`)
      while (feed.children.length > 40) feed.lastElementChild?.remove()
      if (e.type === "EntityCreated" && party.toLowerCase() === cfg.roles.regulator.address.toLowerCase()) toast("⛔ New recall notice from the regulator")
      clearTimeout(timer); timer = window.setTimeout(() => void Promise.allSettled([loadStats(), loadOffers(), loadRecalls()]), 1500)
    },
    onError: () => { err = true; live.textContent = "Live: reconnecting…"; live.className = "live off" },
  })
  setTimeout(() => { if (!got && !err) { live.textContent = "Live: waiting for Arkiv events"; live.className = "live off" } }, 8000)
}
function toast(msg: string) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t)
  setTimeout(() => t.remove(), 6000)
}

// ---------- verify without us ----------
const overBuilder = () => browserPub.select({ key: true, creator: true, attributes: { sku: true, markup_bp: true, unit_price_paise: true, ref_price_paise: true } })
  .where(eq("project", str(PROJECT)), eq("type", str("offer")), gt("markup_bp", i32(OVERPRICED_BP))).limit(200)
function showVerifyCode() {
  $("verifyCode").textContent = `import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { str, i32 } from "@arkiv-network/sdk/attr"
import { eq, gt } from "@arkiv-network/sdk/query"
import { http } from "viem"

const arkiv = createPublicClient({ chain: tiramisu, transport: http() })
let page = await arkiv.select({ key: true, attributes: true })
  .where(eq("project", str("${PROJECT}")), eq("type", str("offer")),
         gt("markup_bp", i32(${OVERPRICED_BP})))   // > 20% above govt price
  .limit(200).fetch()

// Query string sent to the node:
// ${overBuilder().toString()}`
}
async function verifyDirect() {
  $("verifyOut").innerHTML = `<span class="muted">Querying ${esc(tiramisu.rpcUrls.default.http[0])} directly…</span>`
  try {
    const page = await collectPages(await overBuilder().fetch())
    $("verifyOut").innerHTML = `✔ Straight from Arkiv at block ${page.blockNumber}: <b>${page.entities.length}</b> offers priced more than 20% above the official price.<br>${page.entities.map((e) => `${esc(e.attributes?.sku?.value)} ${pct(Number(e.attributes?.markup_bp?.value))}`).join(" · ")}<br><span class="muted small">Compare with the "Overpriced" stat above.</span>`
  } catch (e) { $("verifyOut").innerHTML = `<span class="bad">${esc((e as Error).message.split("\n")[0])}</span>` }
}

// ---------- boot ----------
function fill(id: string, entries: [string, string][]) { $(id).insertAdjacentHTML("beforeend", entries.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("")) }
async function main() {
  cfg = await api<Config>("/api/config")
  fill("priceCat", Object.entries(CATEGORIES).filter(([k]) => k !== "medicines")); fill("ofCat", Object.entries(CATEGORIES))
  $("priceCat").addEventListener("change", renderPrices)
  $("offerFilters").addEventListener("change", () => void loadOffers())
  $("moreOffers").addEventListener("click", () => void loadOffers(true))
  $("findForm").addEventListener("submit", (ev) => { ev.preventDefault(); void find($<HTMLInputElement>("findIn").value) })
  $("verifyBtn").addEventListener("click", () => void verifyDirect())
  document.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement
    const tr = t.closest<HTMLElement>("[data-trace]")?.dataset.trace
    const fd = t.closest<HTMLElement>("[data-find]")?.dataset.find
    const buy = t.closest<HTMLElement>("[data-buy]")?.dataset.buy
    const role = t.closest<HTMLElement>("[data-role]")?.dataset.role as RoleId | undefined
    if (tr) { ev.preventDefault(); void openTrace(tr) }
    else if (fd) { ev.preventDefault(); $<HTMLInputElement>("findIn").value = fd; location.hash = "trace"; void find(fd) }
    else if (buy) void act(() => api(`/api/act/${$<HTMLSelectElement>("buyAs").value}/buy`, { offer: buy }), t as HTMLButtonElement, "buyOut")
    else if (role) { activeRole = role; $("actOut").innerHTML = ""; void renderRole() }
  })
  document.addEventListener("submit", (ev) => {
    const f = ev.target as HTMLFormElement
    const fdata = Object.fromEntries(new FormData(f))
    const btn = f.querySelector("button") as HTMLButtonElement
    if (f.id === "makeForm") { ev.preventDefault(); void act(() => api(`/api/act/${activeRole}/make`, fdata), btn) }
    else if (f.id === "recallForm") { ev.preventDefault(); void act(() => api(`/api/act/regulator/recall`, fdata), btn) }
    else if (f.dataset.offer) { ev.preventDefault(); void act(() => api(`/api/act/${activeRole}/offer`, { lot: f.dataset.offer, qty: fdata.qty, unitPriceRupees: fdata.price }), btn) }
    else if (f.dataset.split) { ev.preventDefault(); void act(() => api(`/api/act/${activeRole}/split`, { lot: f.dataset.split, parts: String(fdata.parts).split(",").map((x) => Number(x.trim())) }), btn) }
  })
  showVerifyCode()
  await Promise.allSettled([loadStats(), loadPrices(), loadOffers(), loadRecalls(), loadParticipants(), renderRole()])
  startFeed()
}
main().catch((e) => { document.querySelector("main")!.insertAdjacentHTML("afterbegin", `<p class="bad">${esc(e.message)}</p>`) })
