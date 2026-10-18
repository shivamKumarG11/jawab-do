// Real official prices: Department of Consumer Affairs daily retail prices (+ optional Agmarknet mandi via data.gov.in).
import { AGMARKNET_RESOURCE, DOCA_URL, classify } from "../src/shared/setu"
import type { PriceInput } from "../src/shared/setuOps"

const clean = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()
const paise = (s: string) => Math.round(Number(s.replace(/[^\d.]/g, "")) * 100)
const changeBp = (cell?: string) => {
  const m = cell?.match(/^([\d.]+)/)
  return m ? Number(m[1]) : undefined
}

export async function fetchDoca(): Promise<{ date: string; prices: PriceInput[] }> {
  let html = ""
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(DOCA_URL, { headers: { "user-agent": "Mozilla/5.0 (SupplySetu demo; open data)" }, signal: AbortSignal.timeout(90_000) })
      if (!res.ok) throw new Error(`DoCA returned HTTP ${res.status}`)
      html = await res.text()
      break
    } catch (e) {
      if (attempt >= 3) throw e
      await new Promise((r) => setTimeout(r, 5_000 * attempt))
    }
  }
  const d = clean(html).match(/Date:\s*(\d{2})\/(\d{2})\/(\d{4})/)
  if (!d) throw new Error("DoCA page has no date")
  const date = `${d[3]}-${d[2]}-${d[1]}`
  const prices: PriceInput[] = []
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => clean(c[1]))
    if (cells.length < 5 || !/^\d/.test(cells[2] ?? "") || !/(kg|ltr|gm|dozen)/i.test(cells[1] ?? "")) continue
    const today = paise(cells[2])
    if (!today) continue
    const { slug, category } = classify(cells[0])
    const m1 = changeBp(cells[4])
    const y1 = changeBp(cells[6])
    prices.push({
      source: "doca", commodity: slug, label: cells[0], category, unit: cells[1], pricePaise: today, date,
      trend1mBp: m1 ? Math.round(((today - paise(String(m1))) * 10_000) / paise(String(m1))) : undefined,
      trend1yBp: y1 ? Math.round(((today - paise(String(y1))) * 10_000) / paise(String(y1))) : undefined,
      raw: cells, url: DOCA_URL,
    })
  }
  if (prices.length < 10) throw new Error(`DoCA parse found only ${prices.length} commodities`)
  return { date, prices }
}

// Optional: wholesale mandi prices (₹/quintal → paise per kg) for a few staples, only with a data.gov.in key.
export async function fetchAgmarknet(apiKey: string, commodities = ["Onion", "Potato", "Tomato", "Wheat", "Rice"]): Promise<PriceInput[]> {
  const out: PriceInput[] = []
  for (const c of commodities) {
    const url = `https://api.data.gov.in/resource/${AGMARKNET_RESOURCE}?api-key=${encodeURIComponent(apiKey)}&format=json&limit=8&filters[commodity]=${encodeURIComponent(c)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`data.gov.in returned HTTP ${res.status}`)
    const j = (await res.json()) as { records?: Record<string, string>[] }
    for (const r of j.records ?? []) {
      const [dd, mm, yyyy] = String(r.arrival_date ?? "").split("/")
      const { slug, category } = classify(c)
      const perKg = (q: string) => Math.round(Number(q) || 0)
      out.push({
        source: "agmarknet", commodity: slug, label: `${c} (${r.market}, ${r.district})`, category, unit: "1 Kg",
        pricePaise: perKg(r.modal_price), minPaise: perKg(r.min_price), maxPaise: perKg(r.max_price),
        date: yyyy ? `${yyyy}-${mm}-${dd}` : new Date().toISOString().slice(0, 10), state: r.state, market: r.market,
        raw: { ...r }, url: `https://data.gov.in/resource/current-daily-price-various-commodities-various-markets-mandi`,
      })
    }
  }
  return out
}
