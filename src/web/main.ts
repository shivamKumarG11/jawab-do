import "./style.css"
import { createPublicClient, createWalletClient } from "@arkiv-network/sdk"
import { str, u64 } from "@arkiv-network/sdk/attr"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { eq, lt } from "@arkiv-network/sdk/query"
import { custom, http, webSocket, type Hex } from "viem"
import { escalateSecondAppeal, fileFirstAppeal, keepAlive, markReplied } from "../shared/ops"
import {
  BASIS, BURN, CATEGORIES, PROJECT, STAGES, authorityLabel, isOverdue,
  type EventView, type RequestView,
} from "../shared/rti"

type Config = {
  explorer: string; wsUrl: string; desk: Hex; legalAid: Hex; writesEnabled: boolean; usingAccessKey: boolean
  states: Record<string, string>; departments: Record<string, { label: string; level: string }>
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
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
const who = (a: string) => {
  const l = a.toLowerCase()
  if (l === cfg.desk.toLowerCase()) return `filing desk ${addrLink(a)}`
  if (l === cfg.legalAid.toLowerCase()) return `legal-aid desk ${addrLink(a)}`
  if (l === BURN.toLowerCase()) return `nobody (burn address ${addrLink(a)})`
  return `wallet ${addrLink(a)}`
}

function span(ms: number) {
  const a = Math.abs(ms)
  if (a >= 2 * DAY) return `${Math.floor(a / DAY)} days`
  const h = Math.floor(a / 3_600_000)
  const m = Math.floor((a % 3_600_000) / 60_000)
  return h ? `${h} h ${m} min` : `${m} min`
}

function clock(r: RequestView) {
  const now = Date.now()
  if (isOverdue(r, now))
    return `<span class="bad">Deemed refused · overdue by ${span(now - r.dueAt)}</span> <small>s.7(2)</small>`
  if (r.stage === "awaiting_reply") return `<span class="${r.dueAt - now < 3 * DAY ? "warn" : "ok"}">Reply due in ${span(r.dueAt - now)}</span>`
  if (r.stage === "first_appeal" && r.faaDueAt)
    return r.faaDueAt < now ? `<span class="bad">Appeal decision overdue by ${span(now - r.faaDueAt)}</span>` : `<span class="ok">Appeal decision due in ${span(r.faaDueAt - now)}</span>`
  if (r.stage === "replied" && r.appealBy) return `<span class="ok">Appeal possible for ${span(r.appealBy - now)}</span>`
  return `<span class="ok">${esc(STAGES[r.stage] ?? r.stage)}</span>`
}

const lifetime = (r: { expiresAtMs?: number; expiresAt: string }) =>
  r.expiresAtMs ? `Record lives ${span(r.expiresAtMs - Date.now())} more (block ${esc(r.expiresAt)})` : `Expires at block ${esc(r.expiresAt)}`

// ---------- Scorecard ----------
async function loadScorecard() {
  const s = await api<{ rows: { authority: string; total: number; overdue: number; awaiting: number; replied: number; appeals: number }[]; queries: Record<string, string> }>("/api/scorecard")
  $("scoreQueries").textContent = `// all trusted requests\n${s.queries.all}\n\n// overdue (numeric range on due_at)\n${s.queries.overdue}`
  $("scorecard").innerHTML = s.rows.length
    ? `<table><thead><tr><th>Public authority</th><th>Filings</th><th>Overdue</th><th>Awaiting</th><th>Replied</th><th>Appeals</th></tr></thead><tbody>${s.rows
        .map((r) => `<tr><td>${esc(authorityLabel(r.authority))}</td><td>${r.total}</td><td class="${r.overdue ? "bad" : ""}">${r.overdue}</td><td>${r.awaiting}</td><td>${r.replied}</td><td>${r.appeals}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="muted">No filings yet.</p>`
}

// ---------- List ----------
let cursor: string | null = null
function filterQs(extra: Record<string, string> = {}) {
  const fd = new FormData($<HTMLFormElement>("filters"))
  const p = new URLSearchParams()
  for (const [k, v] of fd) if (v) p.set(k, String(v))
  for (const [k, v] of Object.entries(extra)) p.set(k, v)
  return p.toString()
}

const card = (r: RequestView) => `
  <article class="req ${r.trusted ? "" : "untrusted"}" data-key="${esc(r.key)}">
    <div class="row between"><b>${esc(r.ref)}</b><span class="stage s-${esc(r.stage)}">${esc(STAGES[r.stage] ?? r.stage)}</span></div>
    <div>${esc(authorityLabel(r.authority))} · ${esc(CATEGORIES[r.category] ?? r.category)}</div>
    <div class="muted">${esc(r.summary ?? "")}</div>
    <div>${clock(r)}</div>
    <div class="muted small">${esc(BASIS[r.basis]?.label ?? r.basis)} · filed ${new Date(r.filedAt).toLocaleDateString("en-IN")} · ${lifetime(r)}</div>
    ${r.trusted ? `<div class="small">✔ Created by trusted ${who(r.creator)}</div>` : `<div class="small badge-bad">⚠ Unverified creator ${addrLink(r.creator)}: not counted</div>`}
  </article>`

async function loadList(append = false) {
  const qs = filterQs(append && cursor ? { cursor } : {})
  const res = await api<{ items: RequestView[]; cursor: string | null; query: string }>(`/api/requests?${qs}`)
  cursor = res.cursor
  $("more").hidden = !cursor
  $("listQuery").textContent = res.query
  const html = res.items.map(card).join("")
  if (append) $("list").insertAdjacentHTML("beforeend", html)
  else $("list").innerHTML = html || `<p class="muted">No matching requests.</p>`
}

// ---------- Detail ----------
async function openDetail(k: string) {
  const d = await api<{ request: RequestView & { overdue: boolean }; events: EventView[]; query: string }>(`/api/request/${k}`)
  const r = d.request
  const owner = r.owner.toLowerCase()
  const relayOwned = owner === cfg.desk.toLowerCase() || owner === cfg.legalAid.toLowerCase()
  const can = {
    reply: r.stage === "awaiting_reply",
    appeal: r.stage === "replied" || r.overdue,
    escalate: r.stage === "first_appeal",
    hearing: r.stage === "second_appeal" && owner === cfg.legalAid.toLowerCase(),
    handover: owner === cfg.desk.toLowerCase(),
  }
  $("detailBody").innerHTML = `
    <h2>${esc(r.ref)} <span class="stage s-${esc(r.stage)}">${esc(STAGES[r.stage])}</span></h2>
    ${r.trusted ? "" : `<p class="badge-bad">⚠ Unverified creator. This looks like a real filing but was not created by a trusted desk, so the scorecard ignores it.</p>`}
    <p>${esc(authorityLabel(r.authority))} · ${esc(CATEGORIES[r.category] ?? r.category)} · ${esc(BASIS[r.basis]?.label)} <small>${esc(BASIS[r.basis]?.section)}</small></p>
    <p class="muted">${esc(r.summary ?? "")}</p>
    <p>${clock(r)}</p>
    <table class="kv">
      <tr><td>Filed</td><td>${new Date(r.filedAt).toLocaleString("en-IN")}</td></tr>
      <tr><td>Reply due</td><td>${new Date(r.dueAt).toLocaleString("en-IN")}</td></tr>
      ${r.repliedAt ? `<tr><td>Replied</td><td>${new Date(r.repliedAt).toLocaleString("en-IN")}</td></tr>` : ""}
      ${r.faaDueAt ? `<tr><td>Appeal decision due</td><td>${new Date(r.faaDueAt).toLocaleString("en-IN")}</td></tr>` : ""}
      <tr><td><code>$creator</code> (never changes)</td><td>${who(r.creator)}</td></tr>
      <tr><td><code>$owner</code> (can update it now)</td><td>${who(r.owner)}</td></tr>
      <tr><td>Entity Expiration</td><td>${lifetime(r)}: the end of the legal remedy for this stage</td></tr>
      <tr><td>Flags</td><td>${r.permissionlessExtension ? "permissionlessExtension: anyone can keep it alive" : "none"}</td></tr>
      <tr><td>Entity key</td><td><code class="small">${esc(r.key)}</code></td></tr>
    </table>
    <h3>Timeline <small class="muted">immutable events: readonly, owned by the burn address</small></h3>
    <ol class="timeline">${d.events
      .map((e) => `<li><b>${esc(e.kind.replace("_", " "))}</b> · ${new Date(e.at).toLocaleString("en-IN")} · ${esc(e.note ?? "")}
        <div class="small muted">created by ${who(e.creator)} · owner ${who(e.owner)} · ${e.readonly ? "readonly" : "editable"}</div></li>`)
      .join("")}</ol>
    <h3>Actions</h3>
    <div class="row wrap actions">
      ${relayOwned && can.reply ? `<button data-act="reply">Mark PIO reply received</button>` : ""}
      ${relayOwned && can.appeal ? `<button data-act="appeal">File first appeal</button>` : ""}
      ${relayOwned && can.escalate ? `<button data-act="escalate">Escalate to second appeal → legal-aid desk</button>` : ""}
      ${can.hearing ? `<button data-act="hearing">Record Commission hearing (renews 90-day lease)</button>` : ""}
      ${can.handover ? `<span class="row"><input id="applicant" placeholder="Applicant wallet 0x…" /><button data-act="handover">Hand over</button></span>` : ""}
      <button data-act="keepalive" class="ghost">Keep alive +30 days with my wallet</button>
      ${!relayOwned ? `<button data-act="mm-reply" ${can.reply ? "" : "hidden"}>Mark replied (sign with my wallet)</button>
        <button data-act="mm-appeal" ${can.appeal ? "" : "hidden"}>First appeal (sign with my wallet)</button>
        <button data-act="mm-escalate" ${can.escalate ? "" : "hidden"}>Second appeal (sign with my wallet)</button>` : ""}
    </div>
    <div id="actOut" class="out"></div>
    <details class="q"><summary>Exact Arkiv query for this timeline</summary><pre>${esc(d.query)}</pre></details>`
  $("detailBody").querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((b) =>
    b.addEventListener("click", () => act(r.key as Hex, b.dataset.act!, b)))
  const dlg = $<HTMLDialogElement>("detail")
  if (!dlg.open) dlg.showModal()
}

async function userWallet() {
  const eth = (window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum
  if (!eth) throw new Error("No browser wallet found. Install MetaMask, add Tiramisu and claim test GLM at hub.arkiv.network/faucet.")
  const [account] = (await eth.request({ method: "eth_requestAccounts" })) as Hex[]
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x7614d1" }] })
  } catch {
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: "0x7614d1", chainName: "Arkiv Tiramisu", nativeCurrency: { name: "GLM", symbol: "GLM", decimals: 18 },
        rpcUrls: [tiramisu.rpcUrls.default.http[0]], blockExplorerUrls: [cfg.explorer] }],
    })
  }
  return createWalletClient({ chain: tiramisu, transport: custom(eth), account })
}

async function act(k: Hex, what: string, btn: HTMLButtonElement) {
  const out = $("actOut")
  btn.disabled = true
  out.innerHTML = `<span class="muted">Sending transaction to Tiramisu…</span>`
  try {
    let res: { txHash: string; previousExpiry?: string | bigint; newExpiry?: string | bigint; extended?: boolean }
    if (what === "keepalive") res = await keepAlive(browserPub, await userWallet(), k)
    else if (what === "mm-reply") res = await markReplied(browserPub, await userWallet(), k)
    else if (what === "mm-appeal") res = await fileFirstAppeal(browserPub, await userWallet(), k)
    else if (what === "mm-escalate") res = await escalateSecondAppeal(browserPub, await userWallet(), k, cfg.legalAid)
    else res = await api(`/api/request/${k}/${what}`, what === "handover" ? { applicant: ($("applicant") as HTMLInputElement).value.trim() } : {})
    const moved = res.newExpiry && String(res.newExpiry) !== "0" && String(res.previousExpiry) !== String(res.newExpiry)
      ? ` · Entity Expiration moved from block ${esc(res.previousExpiry)} to ${esc(res.newExpiry)}` : ""
    out.innerHTML = `✔ Done in one transaction ${txLink(res.txHash)}${moved}`
    await Promise.all([openDetail(k), refreshAll()])
    $("actOut").innerHTML = `✔ Done in one transaction ${txLink(res.txHash)}${moved}`
  } catch (e) {
    out.innerHTML = `<span class="bad">${esc((e as Error).message.split("\n")[0])}</span>`
    btn.disabled = false
  }
}

// ---------- Live feed over WebSocket ----------
function startFeed() {
  const ours = new Set([cfg.desk, cfg.legalAid].map((a) => a.toLowerCase()))
  const wsPub = createPublicClient({ chain: tiramisu, transport: webSocket(cfg.wsUrl) })
  const live = $("live")
  let refreshTimer: number | undefined
  let first = true
  wsPub.watchEntityEvents({
    onEvent: (e) => {
      if (first) { live.textContent = "Live: WebSocket connected"; live.className = "live on"; first = false }
      const parties = [("owner" in e ? e.owner : ""), ("previousOwner" in e ? e.previousOwner : ""), ("newOwner" in e ? e.newOwner : "")]
      if (!parties.some((p) => p && ours.has(p.toLowerCase()))) return
      const feed = $("feed")
      if (feed.querySelector(".muted")) feed.innerHTML = ""
      const label = { EntityCreated: "created", EntityPatched: "patched", ExpiryExtended: "Lifetime Extension", OwnershipTransferred: "ownership transferred", EntityDeleted: "deleted" }[e.type]
      const extra = e.type === "OwnershipTransferred" ? ` → ${who(e.newOwner)}` : e.type === "ExpiryExtended" ? ` → block ${e.expiresAt}` : ""
      feed.insertAdjacentHTML("afterbegin", `<li><b>${label}</b> ${esc(short(e.entityKey))}${extra} · block ${e.blockNumber} · ${txLink(e.transactionHash)}</li>`)
      while (feed.children.length > 30) feed.lastElementChild?.remove()
      clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(refreshAll, 1500)
    },
    onError: () => { live.textContent = "Live: reconnecting…"; live.className = "live off" },
  })
  setTimeout(() => { if (first) { live.textContent = "Live: WebSocket connected (quiet chain)"; live.className = "live on" } }, 8000)
}

// ---------- Verify without us ----------
function overdueBuilder() {
  return browserPub
    .select({ key: true, attributes: { ref: true, authority: true, due_at: true } })
    .where(eq("project", str(PROJECT)), eq("type", str("request")), eq("stage", str("awaiting_reply")), lt("due_at", u64(Date.now())))
    .createdBy(cfg.desk)
    .limit(200)
}
function showVerifyCode() {
  $("verifyCode").textContent = `import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { str, u64 } from "@arkiv-network/sdk/attr"
import { eq, lt } from "@arkiv-network/sdk/query"
import { http } from "viem"

const arkiv = createPublicClient({ chain: tiramisu, transport: http() })
const overdue = await arkiv
  .select({ key: true, attributes: true })
  .where(eq("project", str("${PROJECT}")), eq("type", str("request")),
         eq("stage", str("awaiting_reply")), lt("due_at", u64(Date.now())))
  .createdBy("${cfg.desk}")   // trust comes from $creator
  .fetch()

// Query string sent to the node:
// ${overdueBuilder().toString()}`
}

async function verifyDirect() {
  const out = $("verifyOut")
  out.innerHTML = `<span class="muted">Querying ${esc(tiramisu.rpcUrls.default.http[0])} directly…</span>`
  try {
    const page = await overdueBuilder().fetch()
    const by = new Map<string, number>()
    for (const e of page.entities) {
      const a = String(e.attributes?.authority?.value)
      by.set(a, (by.get(a) ?? 0) + 1)
    }
    out.innerHTML = `✔ Straight from Arkiv at block ${page.blockNumber}: <b>${page.entities.length}</b> overdue filings by the trusted desk.<br>${[...by]
      .map(([a, n]) => `${esc(authorityLabel(a))}: ${n}`).join(" · ")}<br><span class="muted small">Compare with the scorecard's Overdue column.</span>`
  } catch (e) {
    out.innerHTML = `<span class="bad">${esc((e as Error).message.split("\n")[0])}</span><br><span class="muted small">The public RPC limits anonymous reads; the terminal script accepts an access key.</span>`
  }
}

// ---------- Forms ----------
function fillSelect(id: string, entries: [string, string][], keepFirst = false) {
  const el = $<HTMLSelectElement>(id)
  if (!keepFirst) el.innerHTML = ""
  el.insertAdjacentHTML("beforeend", entries.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join(""))
}

async function refreshAll() {
  await Promise.allSettled([loadScorecard(), loadList()])
}

async function main() {
  cfg = await api<Config>("/api/config")
  fillSelect("fState", Object.entries(cfg.states))
  fillSelect("flState", Object.entries(cfg.states), true)
  fillSelect("fDept", Object.entries(cfg.departments).map(([k, v]) => [k, `${v.label} (${v.level})`]))
  fillSelect("fBasis", Object.entries(BASIS).map(([k, v]) => [k, `${v.label} · ${v.section}`]))
  fillSelect("fCat", Object.entries(CATEGORIES))
  fillSelect("flCat", Object.entries(CATEGORIES), true)
  if (!cfg.writesEnabled) $("fileForm").querySelector("button")!.disabled = true

  $("fileForm").addEventListener("submit", async (ev) => {
    ev.preventDefault()
    const form = ev.target as HTMLFormElement
    const btn = form.querySelector("button")!
    btn.disabled = true
    $("fileOut").innerHTML = `<span class="muted">Writing one atomic batch to Tiramisu…</span>`
    try {
      const body = Object.fromEntries(new FormData(form))
      const r = await api<{ ref: string; requestKey: string; txHash: string }>("/api/requests", body)
      $("fileOut").innerHTML = `✔ <b>${esc(r.ref)}</b> logged · tx ${txLink(r.txHash)} · <a href="#" data-open="${esc(r.requestKey)}">open</a>`
      await refreshAll()
    } catch (e) {
      $("fileOut").innerHTML = `<span class="bad">${esc((e as Error).message)}</span>`
    } finally {
      btn.disabled = false
    }
  })
  $("filters").addEventListener("change", () => loadList())
  $("more").addEventListener("click", () => loadList(true))
  $("refForm").addEventListener("submit", async (ev) => {
    ev.preventDefault()
    const ref = ($("refIn") as HTMLInputElement).value.trim()
    if (!ref) return loadList()
    const res = await api<{ items: RequestView[]; query: string }>(`/api/requests?ref=${encodeURIComponent(ref)}`)
    $("list").innerHTML = res.items.map(card).join("") || `<p class="muted">No request with reference ${esc(ref)}.</p>`
    $("listQuery").textContent = res.query
    $("more").hidden = true
  })
  document.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement
    const open = t.closest<HTMLElement>("[data-open]")?.dataset.open ?? (t.closest("a,button") ? undefined : t.closest<HTMLElement>(".req")?.dataset.key)
    if (open) { ev.preventDefault(); void openDetail(open) }
  })
  $("verifyBtn").addEventListener("click", verifyDirect)
  showVerifyCode()
  await refreshAll()
  startFeed()
}

main().catch((e) => { document.querySelector("main")!.insertAdjacentHTML("afterbegin", `<p class="bad">${esc(e.message)}</p>`) })
