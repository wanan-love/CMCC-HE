/**
 * Cloudflare Pages Functions —— 全站 API（D1 数据库）
 *
 * 路由（与沙箱版 src/app/api/* 逐端点对齐，前端零改动）：
 *   GET  /api                    健康检查
 *   GET  /api/stats              总览统计
 *   GET  /api/timeline           时间轴（含高级筛选）
 *   GET  /api/timeline/heatmap   热力图
 *   GET  /api/tariffs            资费库列表
 *   GET  /api/tariffs/:code      资费详情 + 变更历史 + 相似推荐
 *   GET  /api/upcoming           下线预告
 *   GET  /api/insights           数据洞察
 *   GET  /api/export             CSV 导出
 *   GET  /api/feed               RSS / JSON 订阅源
 *   GET  /api/sync               同步运行记录（只读）
 *   POST /api/sync               远端抓取推送（Bearer 令牌 + 差异对比引擎）
 *   GET  /api/sync/runs          同步历史
 *
 * 本地调试：wrangler pages dev pages-out（绑定本地 D1，须先执行 schema init）
 * 生产部署：wrangler pages deploy（wrangler.toml 提供 D1 binding，SYNC_TOKEN 走 Pages Secret）
 */

/* ---------- 最小类型声明（运行于 Workers runtime） ---------- */
interface D1Result<T = Record<string, unknown>> {
  results: T[]
  success: boolean
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  first<T = Record<string, unknown>>(col?: string): Promise<T | null>
  run(): Promise<D1Result>
}
interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>
}
interface Env {
  DB: D1Database
  SYNC_TOKEN?: string
}
interface FnContext {
  request: Request
  env: Env
  params: { path?: string[] }
}

/* ---------- 工具 ---------- */

const json = (data: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  })

const errJson = (error: string, status = 500) => json({ success: false, error }, status)

const nowIso = () => new Date().toISOString()
const todayStr = () => new Date().toISOString().slice(0, 10)

const uuid = () => crypto.randomUUID()

/** SQLite LIKE 转义（Prisma contains 语义：用户输入按字面量处理，% _ \ 不作通配符） */
const likeEsc = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c)
const containsPattern = (s: string) => `%${likeEsc(s)}%`

/** 常量时间比较（Workers 提供 crypto.subtle.timingSafeEqual，失败时降级逐字节异或） */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    const enc = new TextEncoder()
    const subtle = crypto.subtle as unknown as {
      timingSafeEqual?: (x: ArrayBuffer, y: ArrayBuffer) => boolean
    }
    if (typeof subtle.timingSafeEqual === 'function') {
      return subtle.timingSafeEqual(
        enc.encode(a) as unknown as ArrayBuffer,
        enc.encode(b) as unknown as ArrayBuffer
      )
    }
  } catch {
    /* fallthrough */
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** WHERE 子句构建器：条件数组 + 参数数组 */
class WhereBuilder {
  conds: string[] = []
  params: unknown[] = []
  add(cond: string, ...params: unknown[]) {
    this.conds.push(cond)
    this.params.push(...params)
  }
  get sql() {
    return this.conds.length ? ` WHERE ${this.conds.join(' AND ')}` : ''
  }
}

/* ---------- 高级筛选（与 src/lib/adv-filter.ts 同构） ---------- */

const FILTER_CATEGORIES = ['套餐', '加装包', '营销活动', '港澳台/国际资费', '港澳台国际']
const NONE_SENTINEL = '__none__'

interface AdvFilters {
  catIn: string[]
  catOut: string[]
  content: string
  priceMin: number | null
  priceMax: number | null
}

function parseAdvFilters(sp: URLSearchParams): AdvFilters {
  const splitList = (v: string | null) =>
    (v || '')
      .split(',')
      .map((s) => s.trim())
      .filter((c) => FILTER_CATEGORIES.includes(c))
  const num = (v: string | null) => {
    const n = parseFloat((v || '').trim())
    return isNaN(n) || n < 0 ? null : n
  }
  return {
    catIn: splitList(sp.get('catIn')),
    catOut: splitList(sp.get('catOut')),
    content: (sp.get('content') || '').trim().slice(0, 64),
    priceMin: num(sp.get('priceMin')),
    priceMax: num(sp.get('priceMax')),
  }
}

/** 分类合并：in 集合 ∩ 排除集合的补集；空集 → 哨兵（保证「无结果」而非「无条件」） */
function mergedCategories(
  baseCategory: string,
  adv: AdvFilters
): { in: string[] } | { notIn: string[] } | null {
  const inSet = new Set(adv.catIn)
  if (baseCategory && FILTER_CATEGORIES.includes(baseCategory)) inSet.add(baseCategory)
  const outSet = new Set(adv.catOut)
  if (inSet.size && outSet.size) {
    const eff = [...inSet].filter((c) => !outSet.has(c))
    return { in: eff.length ? eff : [NONE_SENTINEL] }
  }
  if (inSet.size) return { in: [...inSet] }
  if (outSet.size) return { notIn: [...outSet] }
  return null
}

/** Tariff 表高级筛选条件（列带前缀 t.） */
function addTariffAdv(w: WhereBuilder, adv: AdvFilters, baseCategory: string) {
  const cat = mergedCategories(baseCategory, adv)
  if (cat) {
    if ('in' in cat) {
      w.add(`t.category IN (${cat.in.map(() => '?').join(',')})`, ...cat.in)
    } else {
      w.add(`t.category NOT IN (${cat.notIn.map(() => '?').join(',')})`, ...cat.notIn)
    }
  }
  if (adv.content) w.add('t.usageJson LIKE ? ESCAPE "\\"', containsPattern(adv.content))
  if (adv.priceMin != null) w.add('t.priceValue >= ?', adv.priceMin)
  if (adv.priceMax != null) w.add('t.priceValue <= ?', adv.priceMax)
}

/** ChangeEvent 表高级筛选（内容/价格经关联 Tariff EXISTS 过滤，与 Prisma relation 语义一致） */
function addEventAdv(w: WhereBuilder, adv: AdvFilters, baseCategory: string) {
  const cat = mergedCategories(baseCategory, adv)
  if (cat) {
    if ('in' in cat) {
      w.add(`e.category IN (${cat.in.map(() => '?').join(',')})`, ...cat.in)
    } else {
      w.add(`e.category NOT IN (${cat.notIn.map(() => '?').join(',')})`, ...cat.notIn)
    }
  }
  if (adv.content || adv.priceMin != null || adv.priceMax != null) {
    const subConds: string[] = []
    const subParams: unknown[] = []
    if (adv.content) {
      subConds.push('t2.usageJson LIKE ? ESCAPE "\\"')
      subParams.push(containsPattern(adv.content))
    }
    if (adv.priceMin != null) {
      subConds.push('t2.priceValue >= ?')
      subParams.push(adv.priceMin)
    }
    if (adv.priceMax != null) {
      subConds.push('t2.priceValue <= ?')
      subParams.push(adv.priceMax)
    }
    w.add(
      `EXISTS (SELECT 1 FROM Tariff t2 WHERE t2.code = e.tariffCode${subConds.length ? ' AND ' + subConds.join(' AND ') : ''})`,
      ...subParams
    )
  }
}

/* ---------- 月份/年份区间（与 src/lib/month-range.ts 同构） ---------- */
function parseMonthRange(month: string): { gte: string; lt: string } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null
  const [y, m] = month.split('-').map(Number)
  if (m < 1 || m > 12) return null
  const nextY = m === 12 ? y + 1 : y
  const nextM = m === 12 ? 1 : m + 1
  return { gte: `${month}-01`, lt: `${nextY}-${String(nextM).padStart(2, '0')}-01` }
}
function parseYearRange(year: string): { gte: string; lt: string } | null {
  if (!/^\d{4}$/.test(year)) return null
  const y = Number(year)
  if (y < 1990 || y > 2100) return null
  return { gte: `${year}-01-01`, lt: `${y + 1}-01-01` }
}

/** 事件日期区间（date > month > year > days 优先级，与沙箱版一致） */
function addDateRange(
  w: WhereBuilder,
  opts: { date?: string; month?: string; year?: string; days?: string; col?: string }
) {
  const col = opts.col ?? 'e.date'
  const monthRange = parseMonthRange(opts.month || '')
  const yearRange = parseYearRange(opts.year || '')
  if (opts.date) {
    w.add(`${col} = ?`, opts.date)
  } else if (monthRange) {
    w.add(`${col} >= ? AND ${col} < ?`, monthRange.gte, monthRange.lt)
  } else if (yearRange) {
    w.add(`${col} >= ? AND ${col} < ?`, yearRange.gte, yearRange.lt)
  } else if (opts.days && opts.days !== 'all') {
    const n = parseInt(opts.days, 10)
    if (!isNaN(n) && n > 0) {
      const since = new Date()
      since.setDate(since.getDate() - n)
      w.add(`${col} >= ?`, since.toISOString().slice(0, 10))
    }
  }
}

/* ══════════════════════════ 端点实现 ══════════════════════════ */

/** GET /api — 健康检查 */
function handleRoot() {
  return json({ message: 'Hello, world!' })
}

/** GET /api/stats */
async function handleStats(env: Env) {
  const today = todayStr()
  const in90 = new Date()
  in90.setDate(in90.getDate() + 90)
  const in90Str = in90.toISOString().slice(0, 10)

  const [tariffCounts, todayByType, lastRun, recentDates, earliest, upcomingCount, upcomingSample, eventSources] =
    await Promise.all([
      env.DB.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'ONLINE' THEN 1 ELSE 0 END) AS online,
                SUM(CASE WHEN status = 'OFFLINE' THEN 1 ELSE 0 END) AS offline
         FROM Tariff`
      ).first<{ total: number; online: number | null; offline: number | null }>(),
      env.DB.prepare(
        `SELECT type, COUNT(*) AS c FROM ChangeEvent WHERE date = ? AND source != 'demo' GROUP BY type`
      )
        .bind(today)
        .all<{ type: string; c: number }>(),
      env.DB.prepare(
        `SELECT * FROM SyncRun WHERE status = 'SUCCESS' ORDER BY startedAt DESC LIMIT 1`
      ).first(),
      env.DB.prepare(
        `SELECT date, COUNT(*) AS c FROM ChangeEvent GROUP BY date ORDER BY date DESC LIMIT 5`
      ).all<{ date: string; c: number }>(),
      env.DB.prepare(`SELECT date FROM ChangeEvent ORDER BY date ASC LIMIT 1`).first<{ date: string }>(),
      env.DB.prepare(
        `SELECT COUNT(*) AS c FROM Tariff WHERE status = 'ONLINE' AND offlineDate IS NOT NULL AND offlineDate >= ? AND offlineDate <= ?`
      )
        .bind(today, in90Str)
        .first<{ c: number }>(),
      env.DB.prepare(
        `SELECT code, name, offlineDate, category, price FROM Tariff
         WHERE status = 'ONLINE' AND offlineDate IS NOT NULL AND offlineDate >= ? AND offlineDate <= ?
         ORDER BY offlineDate ASC LIMIT 8`
      )
        .bind(today, in90Str)
        .all<{ code: string; name: string; offlineDate: string; category: string; price: string | null }>(),
      env.DB.prepare(`SELECT source, COUNT(*) AS c FROM ChangeEvent GROUP BY source`).all<{
        source: string
        c: number
      }>(),
    ])

  const todayMap: Record<string, number> = {}
  for (const r of todayByType.results) todayMap[r.type] = r.c

  return json({
    success: true,
    data: {
      total: tariffCounts?.total ?? 0,
      online: tariffCounts?.online ?? 0,
      offline: tariffCounts?.offline ?? 0,
      today: {
        added: todayMap['ADDED'] ?? 0,
        removed: todayMap['REMOVED'] ?? 0,
        updated: todayMap['UPDATED'] ?? 0,
      },
      upcomingSoon: upcomingCount?.c ?? 0,
      upcomingSample: upcomingSample.results,
      lastRun: lastRun ?? null,
      eventSources: eventSources.results.map((r) => ({
        source: r.source,
        _count: { _all: r.c },
      })),
      recentActiveDates: recentDates.results.map((r) => ({ date: r.date, count: r.c })),
      earliestEventDate: earliest?.date ?? null,
      serverDate: today,
    },
  })
}

/** 时间轴公共条件（分组与明细共用，保证口径一致） */
function buildTimelineWhere(opts: {
  type: string
  source: string
  category: string
  adv: AdvFilters
  q: string
  date?: string
  month?: string
  year?: string
  days?: string
  exactDate?: string
}) {
  const w = new WhereBuilder()
  if (opts.type) w.add('e.type = ?', opts.type)
  if (opts.source) w.add('e.source = ?', opts.source)
  addEventAdv(w, opts.adv, opts.category)
  if (opts.q) {
    w.add(
      '(e.tariffName LIKE ? ESCAPE "\\" OR e.tariffCode LIKE ? ESCAPE "\\" OR e.summary LIKE ? ESCAPE "\\")',
      containsPattern(opts.q),
      containsPattern(opts.q),
      containsPattern(opts.q)
    )
  }
  if (opts.exactDate) {
    w.add('e.date = ?', opts.exactDate)
  } else {
    addDateRange(w, { date: opts.date, month: opts.month, year: opts.year, days: opts.days })
  }
  return w
}

/** GET /api/timeline */
async function handleTimeline(env: Env, sp: URLSearchParams) {
  const days = sp.get('days') || '30'
  const category = sp.get('category') || ''
  const type = sp.get('type') || ''
  const source = sp.get('source') || ''
  const q = (sp.get('q') || '').trim()
  const date = (sp.get('date') || '').trim()
  const month = (sp.get('month') || '').trim()
  const year = (sp.get('year') || '').trim()
  const page = Math.max(1, parseInt(sp.get('page') || '1', 10))
  const pageSize = 12
  const adv = parseAdvFilters(sp)

  const w = buildTimelineWhere({ type, source, category, adv, q, date, month, year, days })

  // 按日期 + 类型分组（准确计数）
  const grouped = await env.DB.prepare(
    `SELECT e.date, e.type, COUNT(*) AS c FROM ChangeEvent e${w.sql} GROUP BY e.date, e.type`
  )
    .bind(...w.params)
    .all<{ date: string; type: string; c: number }>()

  const dayMap = new Map<string, { total: number; byType: Record<string, number> }>()
  for (const g of grouped.results) {
    let d = dayMap.get(g.date)
    if (!d) {
      d = { total: 0, byType: {} }
      dayMap.set(g.date, d)
    }
    d.total += g.c
    d.byType[g.type] = (d.byType[g.type] || 0) + g.c
  }
  const dayList = [...dayMap.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => b.date.localeCompare(a.date))

  const totalDays = dayList.length
  const pageDays = dayList.slice((page - 1) * pageSize, page * pageSize)

  // 每日明细（60 条上限防卡顿；页内各天并行拉取）
  const dayItems = await Promise.all(
    pageDays.map(async (g) => {
      const dw = buildTimelineWhere({
        type,
        source,
        category,
        adv,
        q,
        days: 'all',
        exactDate: g.date,
      })
      const events = await env.DB.prepare(
        `SELECT e.id, e.date, e.type, e.source, e.tariffCode, e.tariffName, e.category, e.changedFields, e.summary, e.createdAt
         FROM ChangeEvent e${dw.sql} ORDER BY e.createdAt DESC LIMIT 60`
      )
        .bind(...dw.params)
        .all()
      return {
        date: g.date,
        total: g.total,
        byType: g.byType,
        events: events.results,
      }
    })
  )

  return json({
    success: true,
    data: {
      days: dayItems,
      totalDays,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(totalDays / pageSize)),
      hasMore: page * pageSize < totalDays,
    },
  })
}

/** GET /api/timeline/heatmap */
async function handleHeatmap(env: Env, sp: URLSearchParams) {
  const days = Math.min(730, parseInt(sp.get('days') || '180', 10))
  const since = new Date()
  since.setDate(since.getDate() - days)
  const sinceStr = since.toISOString().slice(0, 10)

  const grouped = await env.DB.prepare(
    `SELECT date, type, COUNT(*) AS c FROM ChangeEvent WHERE date >= ? GROUP BY date, type`
  )
    .bind(sinceStr)
    .all<{ date: string; type: string; c: number }>()

  const byDate: Record<string, { total: number; added: number; removed: number; updated: number }> = {}
  for (const g of grouped.results) {
    if (!byDate[g.date]) byDate[g.date] = { total: 0, added: 0, removed: 0, updated: 0 }
    const d = byDate[g.date]
    d.total += g.c
    if (g.type === 'ADDED') d.added += g.c
    else if (g.type === 'REMOVED') d.removed += g.c
    else if (g.type === 'UPDATED') d.updated += g.c
  }
  const items = Object.entries(byDate)
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return json({ success: true, data: { items, days } })
}

/** Tariff 列表 WHERE 组装（tariffs / upcoming / export 共用） */
function buildTariffWhere(
  sp: URLSearchParams,
  opts: { status?: string; scope?: string; upcomingWindow?: { from: string; to: string } }
) {
  const w = new WhereBuilder()
  const category = sp.get('category') || ''
  const q = (sp.get('q') || '').trim()
  const adv = parseAdvFilters(sp)
  if (opts.status) w.add('t.status = ?', opts.status)
  if (opts.scope) w.add('t.scope = ?', opts.scope)
  addTariffAdv(w, adv, category)
  if (opts.upcomingWindow) {
    w.add(
      't.offlineDate IS NOT NULL AND t.offlineDate >= ? AND t.offlineDate <= ?',
      opts.upcomingWindow.from,
      opts.upcomingWindow.to
    )
  }
  if (q) {
    const cols = opts.upcomingWindow ? ['t.name', 't.code'] : ['t.name', 't.code', 't.target']
    w.add(
      `(${cols.map((c) => `${c} LIKE ? ESCAPE "\\"`).join(' OR ')})`,
      ...cols.map(() => containsPattern(q))
    )
  }
  return w
}

/** GET /api/tariffs */
async function handleTariffs(env: Env, sp: URLSearchParams) {
  const status = sp.get('status') || ''
  const scope = sp.get('scope') || ''
  const sort = sp.get('sort') || 'newest'
  const page = Math.max(1, parseInt(sp.get('page') || '1', 10))
  const pageSize = Math.min(100, parseInt(sp.get('pageSize') || '12', 10))

  const w = buildTariffWhere(sp, { status: status || undefined, scope: scope || undefined })

  const orderMap: Record<string, string> = {
    newest: 't.onlineDate DESC, t.firstSeenAt DESC',
    oldest: 't.onlineDate ASC',
    'price-asc': 't.priceValue ASC',
    'price-desc': 't.priceValue DESC',
    offline: 't.offlineDate ASC',
  }

  const [items, total] = await Promise.all([
    env.DB.prepare(
      `SELECT t.code, t.name, t.category, t.scope, t."range" AS "range", t.price, t.priceValue, t.onlineDate, t.offlineDate, t.status, t.target
       FROM Tariff t${w.sql} ORDER BY ${orderMap[sort] || orderMap.newest} LIMIT ? OFFSET ?`
    )
      .bind(...w.params, pageSize, (page - 1) * pageSize)
      .all(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM Tariff t${w.sql}`)
      .bind(...w.params)
      .first<{ c: number }>(),
  ])

  const totalCount = total?.c ?? 0
  return json({
    success: true,
    data: {
      items: items.results,
      total: totalCount,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
    },
  })
}

/** GET /api/tariffs/:code */
async function handleTariffDetail(env: Env, code: string) {
  const tariff = await env.DB.prepare(`SELECT * FROM Tariff WHERE code = ?`)
    .bind(code)
    .first<{
      code: string
      category: string
      scope: string
      priceValue: number | null
      onlineDate: string | null
      target: string | null
      channels: string | null
    }>()
  if (!tariff) return errJson('未找到该资费', 404)

  const events = await env.DB.prepare(
    `SELECT id, date, type, source, tariffCode, tariffName, category, changedFields, summary, createdAt
     FROM ChangeEvent WHERE tariffCode = ? ORDER BY date DESC`
  )
    .bind(code)
    .all()

  // 相似推荐：同分类 + 在售 + 同 scope，评分与沙箱版同构
  const candidates = await env.DB.prepare(
    `SELECT code, name, category, price, priceValue, onlineDate, offlineDate, target, channels
     FROM Tariff WHERE code != ? AND category = ? AND status = 'ONLINE' AND scope = ? LIMIT 200`
  )
    .bind(code, tariff.category, tariff.scope)
    .all<{
      code: string
      name: string
      category: string
      price: string | null
      priceValue: number | null
      onlineDate: string | null
      offlineDate: string | null
      target: string | null
      channels: string | null
    }>()

  interface Scored {
    code: string
    name: string
    category: string
    price: string | null
    priceValue: number | null
    onlineDate: string | null
    offlineDate: string | null
    target: string | null
    matchTags: string[]
    score: number
  }
  const scored: Scored[] = candidates.results.map((t) => {
    const tags: string[] = []
    let score = 0
    if (tariff.priceValue !== null && t.priceValue !== null) {
      const base = tariff.priceValue
      const ratio = Math.abs(t.priceValue - base) / Math.max(base, 1)
      if (ratio <= 0.4) {
        score += 40 * (1 - ratio / 0.4)
        if (ratio === 0) tags.push('同价')
        else if (ratio <= 0.1) tags.push('价差±10%')
      } else {
        score -= (ratio - 0.4) * 20
      }
    }
    if (tariff.target && t.target && tariff.target === t.target) {
      score += 15
      tags.push('同适用人群')
    }
    if (tariff.channels && t.channels && tariff.channels === t.channels) {
      score += 8
      tags.push('同销售渠道')
    }
    if (tariff.onlineDate && t.onlineDate) {
      const days = Math.abs(
        (new Date(t.onlineDate).getTime() - new Date(tariff.onlineDate).getTime()) / 86_400_000
      )
      if (days <= 90) {
        score += 5
        if (days <= 30) tags.push('同期上线')
      }
    }
    return { ...t, matchTags: tags, score }
  })

  const similar = scored
    .sort((a, b) => {
      if (tariff.priceValue !== null) {
        const inRange = (x: Scored) =>
          x.priceValue !== null && Math.abs(x.priceValue - tariff.priceValue!) / Math.max(tariff.priceValue!, 1) <= 0.4
        const inA = inRange(a)
        const inB = inRange(b)
        if (inA !== inB) return inA ? -1 : 1
      }
      return b.score - a.score
    })
    .slice(0, 6)
    .map(({ matchTags, ...rest }) => ({ ...rest, matchTags }))

  return json({ success: true, data: { tariff, events: events.results, similar } })
}

/** GET /api/upcoming */
async function handleUpcoming(env: Env, sp: URLSearchParams) {
  const days = Math.min(365, Math.max(1, parseInt(sp.get('days') || '90', 10)))
  const sort = sp.get('sort') || 'date-asc'
  const today = todayStr()
  const until = new Date()
  until.setDate(until.getDate() + days)
  const untilStr = until.toISOString().slice(0, 10)

  const w = buildTariffWhere(sp, {
    status: 'ONLINE',
    upcomingWindow: { from: today, to: untilStr },
  })

  const orderMap: Record<string, string> = {
    'date-asc': 't.offlineDate ASC',
    'date-desc': 't.offlineDate DESC',
    'price-asc': 't.priceValue ASC',
    'price-desc': 't.priceValue DESC',
  }

  const [items, total] = await Promise.all([
    env.DB.prepare(
      `SELECT t.code, t.name, t.category, t.scope, t."range" AS "range", t.price, t.priceValue, t.onlineDate, t.offlineDate, t.status, t.target
       FROM Tariff t${w.sql} ORDER BY ${orderMap[sort] || orderMap['date-asc']} LIMIT 1000`
    )
      .bind(...w.params)
      .all(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM Tariff t${w.sql}`)
      .bind(...w.params)
      .first<{ c: number }>(),
  ])

  // 按月份分组（与沙箱版同构：YYYY-MM → 条目数组）
  const byMonth: Record<string, typeof items.results> = {}
  for (const t of items.results) {
    const month = (t.offlineDate || '').slice(0, 7)
    if (!byMonth[month]) byMonth[month] = []
    byMonth[month].push(t)
  }

  return json({
    success: true,
    data: { items: items.results, byMonth, total: total?.c ?? 0, rangeDays: days },
  })
}

/** GET /api/insights */
async function handleInsights(env: Env) {
  const since24m = new Date()
  since24m.setMonth(since24m.getMonth() - 24)
  since24m.setDate(1)
  const since24mStr = since24m.toISOString().slice(0, 10)
  const since24mHist = new Date()
  since24mHist.setMonth(since24mHist.getMonth() - 24)
  const since24mHistStr = since24mHist.toISOString().slice(0, 10)

  const [
    byCategory,
    byScope,
    monthlyRaw,
    planBuckets,
    addonBuckets,
    byYear,
    changesRaw,
    catMonthlyRaw,
    planPrices,
    addonPrices,
    totalFree,
  ] = await Promise.all([
    env.DB.prepare(`SELECT category AS k, COUNT(*) AS c FROM Tariff GROUP BY category ORDER BY c DESC`).all<{
      k: string
      c: number
    }>(),
    env.DB.prepare(`SELECT scope AS k, COUNT(*) AS c FROM Tariff GROUP BY scope`).all<{ k: string; c: number }>(),
    env.DB.prepare(
      `SELECT substr(date, 1, 7) AS m, COUNT(*) AS c FROM ChangeEvent
       WHERE type = 'ADDED' AND source = 'history' AND date >= ? GROUP BY m ORDER BY m`
    )
      .bind(since24mHistStr)
      .all<{ m: string; c: number }>(),
    env.DB.prepare(
      `SELECT CASE
         WHEN priceValue < 20 THEN '0-19元'
         WHEN priceValue < 50 THEN '20-49元'
         WHEN priceValue < 100 THEN '50-99元'
         WHEN priceValue < 200 THEN '100-199元'
         WHEN priceValue < 500 THEN '200-499元'
         ELSE '500元以上' END AS k, COUNT(*) AS c
       FROM Tariff WHERE priceValue IS NOT NULL AND category = '套餐' GROUP BY k`
    ).all<{ k: string; c: number }>(),
    env.DB.prepare(
      `SELECT CASE
         WHEN priceValue = 0 THEN '0元'
         WHEN priceValue < 10 THEN '1-9元'
         WHEN priceValue < 20 THEN '10-19元'
         WHEN priceValue < 50 THEN '20-49元'
         WHEN priceValue < 100 THEN '50-99元'
         ELSE '100元以上' END AS k, COUNT(*) AS c
       FROM Tariff WHERE priceValue IS NOT NULL AND category = '加装包' GROUP BY k`
    ).all<{ k: string; c: number }>(),
    env.DB.prepare(
      `SELECT substr(onlineDate, 1, 4) AS y, COUNT(*) AS c FROM Tariff
       WHERE onlineDate IS NOT NULL AND substr(onlineDate, 1, 4) >= '2016' GROUP BY y ORDER BY y`
    ).all<{ y: string; c: number }>(),
    env.DB.prepare(
      `SELECT substr(date, 1, 7) AS m, type, COUNT(*) AS c FROM ChangeEvent
       WHERE date >= ? AND source != 'demo' GROUP BY m, type ORDER BY m`
    )
      .bind(since24mStr)
      .all<{ m: string; type: string; c: number }>(),
    env.DB.prepare(
      `SELECT substr(date, 1, 7) AS m, category, COUNT(*) AS c FROM ChangeEvent
       WHERE date >= ? AND type = 'ADDED' AND source != 'demo'
         AND category IN ('套餐', '加装包', '营销活动', '港澳台/国际资费')
       GROUP BY m, category ORDER BY m`
    )
      .bind(since24mStr)
      .all<{ m: string; category: string; c: number }>(),
    env.DB.prepare(`SELECT priceValue FROM Tariff WHERE category = '套餐' AND priceValue IS NOT NULL`).all<{
      priceValue: number
    }>(),
    env.DB.prepare(`SELECT priceValue FROM Tariff WHERE category = '加装包' AND priceValue IS NOT NULL`).all<{
      priceValue: number
    }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM Tariff WHERE priceValue = 0`).first<{ c: number }>(),
  ])

  // 价格桶（固定顺序，缺失补 0）
  const planOrder = ['0-19元', '20-49元', '50-99元', '100-199元', '200-499元', '500元以上']
  const planKeyMap: Record<string, string> = {
    '0-19元': 'lte29',
    '20-49元': '30-59',
    '50-99元': '60-99',
    '100-199元': '100-199',
    '200-499元': 'gte200',
    '500元以上': 'gte200',
  }
  const planCount: Record<string, number> = {}
  for (const r of planBuckets.results) planCount[r.k] = r.c
  const addonOrder = ['0元', '1-9元', '10-19元', '20-49元', '50-99元', '100元以上']
  const addonKeyMap: Record<string, string> = {
    '0元': 'free',
    '1-9元': 'lte29',
    '10-19元': 'lte29',
    '20-49元': '30-59',
    '50-99元': '60-99',
    '100元以上': 'gte200',
  }
  const addonCount: Record<string, number> = {}
  for (const r of addonBuckets.results) addonCount[r.k] = r.c

  // 24 个月月度三序列（上线/下线/变更）
  const changesByMonth: Record<string, { added: number; removed: number; updated: number }> = {}
  for (const r of changesRaw.results) {
    if (!changesByMonth[r.m]) changesByMonth[r.m] = { added: 0, removed: 0, updated: 0 }
    if (r.type === 'ADDED') changesByMonth[r.m].added += r.c
    else if (r.type === 'REMOVED') changesByMonth[r.m].removed += r.c
    else if (r.type === 'UPDATED') changesByMonth[r.m].updated += r.c
  }
  const monthlyChanges = Object.entries(changesByMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([m, v]) => ({ month: m, ...v }))

  // 24 个月新上线分类构成（每月四分类齐全 —— 与沙箱版对象形状一致）
  const catByMonth: Record<string, Record<string, number>> = {}
  for (const r of catMonthlyRaw.results) {
    if (!catByMonth[r.m]) catByMonth[r.m] = { 套餐: 0, 加装包: 0, 营销活动: 0, '港澳台/国际资费': 0 }
    catByMonth[r.m][r.category] = (catByMonth[r.m][r.category] || 0) + r.c
  }
  const categoryMonthly = Object.entries(catByMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([m, v]) => ({ month: m, ...v }))

  // 价格统计（中位数在 JS 计算）
  const median = (vals: number[]) => {
    if (vals.length === 0) return null
    const s = [...vals].sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 100) / 100
  }
  const planVals = planPrices.results.map((p) => p.priceValue)
  const addonVals = addonPrices.results.map((p) => p.priceValue)
  const priceStats = {
    planMedian: median(planVals),
    planFree: planVals.filter((v) => v === 0).length,
    planPriced: planVals.length,
    addonMedian: median(addonVals),
    addonFree: addonVals.filter((v) => v === 0).length,
    addonPriced: addonVals.length,
    totalFree: totalFree?.c ?? 0,
  }

  return json({
    success: true,
    data: {
      byCategory: byCategory.results.map((r) => ({ name: r.k, value: r.c })),
      byScope: byScope.results.map((r) => ({ name: r.k, value: r.c })),
      monthly: monthlyRaw.results.map((r) => ({ month: r.m, count: r.c })),
      monthlyChanges,
      priceBuckets: planOrder.map((name) => ({ name, count: planCount[name] ?? 0, key: planKeyMap[name] })),
      addonPriceBuckets: addonOrder.map((name) => ({
        name,
        count: addonCount[name] ?? 0,
        key: addonKeyMap[name],
      })),
      categoryMonthly,
      priceStats,
      byYear: byYear.results.map((r) => ({ year: r.y, count: r.c })),
    },
  })
}

/* ---------- CSV 导出 ---------- */

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

const csvResponse = (csv: string, filename: string) =>
  new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })

/** GET /api/export?kind=events */
async function exportEventsCsv(env: Env, sp: URLSearchParams) {
  const type = sp.get('type') || ''
  const source = sp.get('source') || ''
  const q = (sp.get('q') || '').trim()
  const category = sp.get('category') || ''
  const adv = parseAdvFilters(sp)

  const w = new WhereBuilder()
  addDateRange(w, {
    date: sp.get('date') || '',
    month: (sp.get('month') || '').trim(),
    year: (sp.get('year') || '').trim(),
    days: sp.get('days') || '',
  })
  if (type) w.add('e.type = ?', type)
  if (source) w.add('e.source = ?', source)
  addEventAdv(w, adv, category)
  if (q) {
    w.add(
      '(e.tariffName LIKE ? ESCAPE "\\" OR e.tariffCode LIKE ? ESCAPE "\\")',
      containsPattern(q),
      containsPattern(q)
    )
  }

  const events = await env.DB.prepare(
    `SELECT e.date, e.type, e.tariffCode, e.tariffName, e.category, e.changedFields, e.summary, e.source,
            t.price AS t_price, t.scope AS t_scope, t."range" AS t_range, t.channels AS t_channels,
            t.onlineDate AS t_onlineDate, t.offlineDate AS t_offlineDate
     FROM ChangeEvent e LEFT JOIN Tariff t ON t.code = e.tariffCode${w.sql}
     ORDER BY e.date DESC, e.type ASC LIMIT 5000`
  )
    .bind(...w.params)
    .all<Record<string, string | null>>()

  const typeLabels: Record<string, string> = { ADDED: '上线', REMOVED: '下线', UPDATED: '变更' }
  const header = [
    '日期',
    '事件类型',
    '资费编号',
    '资费名称',
    '分类',
    '资费标准',
    '适用对象',
    '适用范围',
    '销售渠道',
    '上线日期',
    '下线日期',
    '事件来源',
    '变更摘要',
    '变更字段明细',
  ]
  const lines: string[] = ['\uFEFF' + header.join(',')]
  for (const e of events.results) {
    let detail = ''
    if (e.changedFields) {
      try {
        const changes = JSON.parse(e.changedFields) as {
          field: string
          before: string | null
          after: string | null
        }[]
        detail = changes.map((c) => `${c.field}: ${c.before ?? '—'} → ${c.after ?? '—'}`).join('；')
      } catch {
        /* ignore */
      }
    }
    lines.push(
      [
        e.date,
        typeLabels[e.type ?? ''] ?? e.type,
        e.tariffCode ?? '',
        e.tariffName,
        e.category ?? '',
        e.t_price ?? '',
        e.t_scope ?? '',
        e.t_range ?? '',
        e.t_channels ?? '',
        e.t_onlineDate ?? '',
        e.t_offlineDate ?? '',
        e.source,
        e.summary ?? '',
        detail,
      ]
        .map(csvEscape)
        .join(',')
    )
  }
  return csvResponse(lines.join('\r\n'), `tariff-events-${todayStr()}.csv`)
}

/** GET /api/export（资费库） */
async function exportTariffsCsv(env: Env, sp: URLSearchParams) {
  const status = sp.get('status') || ''
  const scope = sp.get('scope') || ''

  const w = buildTariffWhere(sp, { status: status || undefined, scope: scope || undefined })

  const items = await env.DB.prepare(
    `SELECT * FROM Tariff t${w.sql} ORDER BY t.onlineDate DESC, t.firstSeenAt DESC LIMIT 5000`
  )
    .bind(...w.params)
    .all<Record<string, string | null>>()

  const header = [
    '方案编号',
    '资费名称',
    '资费类型',
    '适用对象',
    '适用范围',
    '省份',
    '资费标准',
    '上线日期',
    '下线日期',
    '适用范围说明',
    '销售渠道',
    '有效期限',
    '在网要求',
    '退订方式',
    '违约责任',
    '套餐内容',
    '其他说明',
    '状态',
  ]
  const lines: string[] = ['\uFEFF' + header.join(',')]
  for (const t of items.results) {
    let usage = ''
    try {
      const arr = JSON.parse(t.usageJson || '[]') as { label: string; value: string }[]
      usage = arr.map((u) => `${u.label}:${u.value}`).join('；')
    } catch {
      /* ignore */
    }
    let extra = ''
    try {
      const obj = JSON.parse(t.extraJson || '{}') as Record<string, string>
      extra = Object.entries(obj)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}:${v}`)
        .join('；')
    } catch {
      /* ignore */
    }
    lines.push(
      [
        t.code,
        t.name,
        t.category,
        t.scope,
        t.range,
        t.province,
        t.price,
        t.onlineDate,
        t.offlineDate,
        t.target,
        t.channels,
        t.effective,
        t.requirement,
        t.unsubscribe,
        t.liability,
        usage,
        extra,
        t.status === 'ONLINE' ? '在售' : '已下线',
      ]
        .map(csvEscape)
        .join(',')
    )
  }
  return csvResponse(lines.join('\r\n'), `hebei-tariffs-${todayStr()}.csv`)
}

/* ---------- 订阅源 ---------- */

const VALID_CATEGORIES = ['套餐', '加装包', '营销活动', '港澳台/国际资费']
const TYPE_PREFIX: Record<string, string> = { ADDED: '🟢 上线', REMOVED: '🔴 下线', UPDATED: '🟡 变更' }

const escXml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, ']]&gt;')}]]>`

/** GET /api/feed */
async function handleFeed(env: Env, sp: URLSearchParams, origin: string) {
  const days = Math.min(Math.max(parseInt(sp.get('days') ?? '30', 10) || 30, 1), 365)
  const limit = Math.min(Math.max(parseInt(sp.get('limit') ?? '50', 10) || 50, 1), 200)
  const type = sp.get('type') || ''
  const category = sp.get('category') || ''
  const region = sp.get('region') || ''
  const format = sp.get('format')

  const since = new Date()
  since.setDate(since.getDate() - days)
  const sinceStr = since.toISOString().slice(0, 10)

  const w = new WhereBuilder()
  w.add('date >= ?', sinceStr)
  w.add("source != 'demo'")
  if (type && ['ADDED', 'REMOVED', 'UPDATED'].includes(type)) w.add('type = ?', type)
  if (category && VALID_CATEGORIES.includes(category)) w.add('category = ?', category)
  if (region === 'HEBEI') {
    // 仅看河北专属资费：事件关联资费的适用范围为「河北」（无关联的事件自然排除）
    w.add(`EXISTS (SELECT 1 FROM Tariff t3 WHERE t3.code = ChangeEvent.tariffCode AND t3."range" = '河北')`)
  }

  const events = await env.DB.prepare(
    `SELECT * FROM ChangeEvent${w.sql} ORDER BY date DESC, createdAt DESC LIMIT ?`
  )
    .bind(...w.params, limit)
    .all<{
      date: string
      type: string
      tariffCode: string | null
      tariffName: string
      category: string | null
      summary: string | null
      changedFields: string | null
    }>()

  if (format === 'json') {
    return json({
      success: true,
      data: {
        title: '河北移动资费变更速递',
        description: `最近 ${days} 天中国移动资费公示变更（上线/下线/内容调整）`,
        generatedAt: nowIso(),
        days,
        count: events.results.length,
        filter: { type: type || null, category: category || null, region: region || null },
        items: events.results.map((e) => ({
          date: e.date,
          type: e.type,
          tariffCode: e.tariffCode,
          tariffName: e.tariffName,
          category: e.category,
          summary: e.summary,
          changedFields: e.changedFields ? JSON.parse(e.changedFields) : null,
        })),
      },
    })
  }

  const siteUrl = origin
  const items = events.results
    .map((e) => {
      const prefix = TYPE_PREFIX[e.type] ?? '事件'
      const link = e.tariffCode ? `${siteUrl}/?tariff=${e.tariffCode}` : `${siteUrl}/?tab=timeline`
      let desc = e.summary ?? ''
      if (e.changedFields) {
        try {
          const fields: { field: string; before: string | null; after: string | null }[] = JSON.parse(
            e.changedFields
          )
          if (fields.length) {
            desc += '\n\n' + fields.map((f) => `・${f.field}：${f.before ?? '（空）'} → ${f.after ?? '（空）'}`).join('\n')
          }
        } catch {
          /* ignore */
        }
      }
      return `    <item>
      <title>${escXml(`${prefix}｜${e.tariffName}`)}</title>
      <link>${escXml(link)}</link>
      <guid isPermaLink="false">${escXml(`${e.date}-${e.type}-${e.tariffCode ?? e.tariffName}`)}</guid>
      <pubDate>${new Date(e.date + 'T08:00:00+08:00').toUTCString()}</pubDate>
      <category>${escXml(e.category ?? '资费')}</category>
      <description>${cdata(desc)}</description>
    </item>`
    })
    .join('\n')

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>河北移动资费变更速递</title>
    <link>${escXml(siteUrl)}</link>
    <description>每日对比中国移动资费公示页：资费上线、下线、内容调整尽在掌握</description>
    <language>zh-CN</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <ttl>720</ttl>
    <atom:link href="${escXml(`${siteUrl}/api/feed`)}" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`

  return new Response(rss, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=600' },
  })
}

/* ---------- 同步：运行记录 + 差异引擎 ---------- */

/** GET /api/sync 与 /api/sync/runs —— 运行记录（只读公开） */
async function handleSyncRuns(env: Env, take: number) {
  const runs = await env.DB.prepare(
    `SELECT id, startedAt, finishedAt, date, status, source, mode, totalBefore, totalAfter, added, removed, updated, message, undoJson, undoneAt
     FROM SyncRun ORDER BY startedAt DESC LIMIT ?`
  )
    .bind(take)
    .all()
  return json({ success: true, data: { runs: runs.results } })
}

interface IncomingTariff {
  code: string
  name: string
  category: string
  scope: string
  range: string
  province: string
  price: string | null
  priceValue: number | null
  onlineDate: string | null
  offlineDate: string | null
  target: string | null
  channels: string | null
  effective: string | null
  requirement: string | null
  unsubscribe: string | null
  liability: string | null
  usageJson: string
  extraJson: string
  contentHash: string
}

const MAX_ITEMS = 10000

/** 同步令牌校验（与沙箱版同语义：未配置 = 本地开发放行） */
function verifySyncToken(request: Request, env: Env): { ok: boolean; reason?: string } {
  const token = env.SYNC_TOKEN
  if (!token) return { ok: true }
  const auth = request.headers.get('authorization') || ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  const header = (request.headers.get('x-sync-token') || '').trim()
  const query = (new URL(request.url).searchParams.get('token') || '').trim()
  const provided = bearer || header || query
  if (!provided) return { ok: false, reason: '缺少同步令牌（Authorization: Bearer <token>）' }
  if (!timingSafeEqualStr(provided, token)) return { ok: false, reason: '同步令牌不正确' }
  return { ok: true }
}

function validateItems(items: unknown): { ok: boolean; data?: IncomingTariff[]; error?: string } {
  if (!Array.isArray(items)) return { ok: false, error: 'items 必须是数组' }
  if (items.length === 0) return { ok: false, error: 'items 不能为空' }
  if (items.length > MAX_ITEMS) return { ok: false, error: `items 超过上限 ${MAX_ITEMS} 条` }
  const REQUIRED_STR: (keyof IncomingTariff)[] = [
    'code',
    'name',
    'category',
    'scope',
    'range',
    'usageJson',
    'extraJson',
    'contentHash',
  ]
  const cleaned: IncomingTariff[] = []
  for (const it of items) {
    if (typeof it !== 'object' || it === null) return { ok: false, error: 'items 内含非对象条目' }
    const t = it as Record<string, unknown>
    for (const key of REQUIRED_STR) {
      if (typeof t[key] !== 'string' || !(t[key] as string).trim()) {
        return { ok: false, error: `条目缺少必填字段 ${String(key)}` }
      }
    }
    if ((t.code as string).length > 64 || (t.name as string).length > 256) {
      return { ok: false, error: 'code/name 字段过长' }
    }
    cleaned.push({
      code: t.code as string,
      name: t.name as string,
      category: t.category as string,
      scope: t.scope as string,
      range: t.range as string,
      province: typeof t.province === 'string' ? t.province : '河北',
      price: (t.price as string | null) ?? null,
      priceValue: typeof t.priceValue === 'number' ? t.priceValue : null,
      onlineDate: (t.onlineDate as string | null) ?? null,
      offlineDate: (t.offlineDate as string | null) ?? null,
      target: (t.target as string | null) ?? null,
      channels: (t.channels as string | null) ?? null,
      effective: (t.effective as string | null) ?? null,
      requirement: (t.requirement as string | null) ?? null,
      unsubscribe: (t.unsubscribe as string | null) ?? null,
      liability: (t.liability as string | null) ?? null,
      usageJson: t.usageJson as string,
      extraJson: t.extraJson as string,
      contentHash: t.contentHash as string,
    })
  }
  return { ok: true, data: cleaned }
}

const TARIFF_INSERT_SQL = `INSERT INTO Tariff
  (id, code, name, category, scope, "range", province, price, priceValue, onlineDate, offlineDate,
   target, channels, effective, requirement, unsubscribe, liability, usageJson, extraJson, contentHash,
   firstSeenAt, lastSeenAt, status, removedAt)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`

const EVENT_INSERT_SQL = `INSERT INTO ChangeEvent
  (id, date, type, source, tariffCode, tariffName, category, changedFields, summary, syncRunId, createdAt)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`

/** UPDATE 构造（code 字面量经 JSON 转义嵌入 —— 与 SQL 字符串转义规则兼容且安全） */
const updateSql = (sets: string[], code: string) =>
  `UPDATE Tariff SET ${sets.join(', ')} WHERE code = ${JSON.stringify(code)}`

/** REMOVED 二次确认阈值：连续 N 次同步未见才判下线 */
const REMOVED_MISS_THRESHOLD = 2

/**
 * 差异同步引擎（D1 版）——与沙箱版语义一致 + 首灌历史重构：
 *  1. 全表读一次 diff 所需列；「无变化不写」；批量事务提交（每批 ≤400 语句，单语句参数 ≤100）
 *  2. 新增资费除「今日 ADDED(sync)」外，若带有效上线日期（≤今日）同时生成「ADDED(history)」事件
 *     并回填 firstSeenAt —— 复刻 seed-db 的历史重构，Action 首灌即拥有完整时间轴纵深
 *  3. REMOVED 二次确认（2026-09-04 事故后新增）：在线但本次未抓到 → missCount+1，
 *     连续达到阈值（2）才 OFFLINE + REMOVED 事件；单次缺失仅累加计数保持 ONLINE，
 *     防单次抓取缺失（漏抓/限流/批次在途）→ 假下线事件污染时间轴。
 *     代价：真实下线确认延迟 1 天（下线预告由 offlineDate 提前预警，不受影响）。
 */
async function runDiffSync(env: Env, incoming: IncomingTariff[], runId: string) {
  const today = todayStr()
  const now = nowIso()

  const existing = await env.DB.prepare(
    `SELECT code, name, category, price, priceValue, onlineDate, offlineDate, target, channels,
            effective, requirement, unsubscribe, liability, usageJson, extraJson, contentHash, status, missCount
     FROM Tariff`
  ).all<{
    code: string
    name: string
    category: string
    price: string | null
    priceValue: number | null
    onlineDate: string | null
    offlineDate: string | null
    target: string | null
    channels: string | null
    effective: string | null
    requirement: string | null
    unsubscribe: string | null
    liability: string | null
    usageJson: string
    extraJson: string
    contentHash: string
    status: string
    missCount: number
  }>()
  const byCode = new Map(existing.results.map((t) => [t.code, t]))

  interface EventRow {
    date: string
    type: string
    source: string
    tariffCode: string
    tariffName: string
    category: string | null
    summary: string
    changedFields?: string
  }

  const stmts: D1PreparedStatement[] = []
  const addEvent = (e: EventRow) => {
    stmts.push(
      env.DB.prepare(EVENT_INSERT_SQL).bind(
        uuid(),
        e.date,
        e.type,
        e.source,
        e.tariffCode,
        e.tariffName,
        e.category,
        e.changedFields ?? null,
        e.summary,
        runId,
        now
      )
    )
  }

  let added = 0
  let removed = 0
  let updated = 0
  let pendingMiss = 0

  for (const t of incoming) {
    const cur = byCode.get(t.code)
    if (!cur) {
      const validOnline =
        t.onlineDate && /^\d{4}-\d{2}-\d{2}$/.test(t.onlineDate) && t.onlineDate <= today
      const firstSeen = validOnline ? new Date(t.onlineDate + 'T08:00:00Z').toISOString() : now
      stmts.push(
        env.DB.prepare(TARIFF_INSERT_SQL).bind(
          uuid(),
          t.code,
          t.name,
          t.category,
          t.scope,
          t.range,
          t.province,
          t.price,
          t.priceValue,
          t.onlineDate,
          t.offlineDate,
          t.target,
          t.channels,
          t.effective,
          t.requirement,
          t.unsubscribe,
          t.liability,
          t.usageJson,
          t.extraJson,
          t.contentHash,
          firstSeen,
          now,
          'ONLINE'
        )
      )
      added++
      addEvent({
        date: today,
        type: 'ADDED',
        source: 'sync',
        tariffCode: t.code,
        tariffName: t.name,
        category: t.category,
        summary: `新资费上线「${t.name}」（${t.price ?? '价格未公示'}）`,
      })
      // 历史重构：按真实上线日期补时间轴（与 seed-db 首灌同构）
      if (validOnline) {
        addEvent({
          date: t.onlineDate!,
          type: 'ADDED',
          source: 'history',
          tariffCode: t.code,
          tariffName: t.name,
          category: t.category,
          summary: `「${t.name}」上线（${t.price ?? '价格未公示'}）`,
        })
      }
    } else if (cur.status === 'OFFLINE') {
      // 重新上线：此前标记下线，但本次抓取又出现了
      stmts.push(
        env.DB.prepare(
          updateSql(
            [
              'status = ?',
              'removedAt = NULL',
              'missCount = 0',
              'lastSeenAt = ?',
              'contentHash = ?',
              'name = ?',
              'price = ?',
              'priceValue = ?',
              'onlineDate = ?',
              'offlineDate = ?',
            ],
            t.code
          )
        ).bind('ONLINE', now, t.contentHash, t.name, t.price, t.priceValue, t.onlineDate, t.offlineDate)
      )
      added++
      addEvent({
        date: today,
        type: 'ADDED',
        source: 'sync',
        tariffCode: t.code,
        tariffName: t.name,
        category: t.category,
        summary: `「${t.name}」重新上线（此前已下线）`,
      })
    } else if (cur.contentHash !== t.contentHash) {
      // 内容变更：找出具体字段差异
      const changes: { field: string; before: string | null; after: string | null }[] = []
      const fieldMap: [string, string | null, string | null][] = [
        ['资费名称', cur.name, t.name],
        ['资费标准', cur.price, t.price],
        ['上线日期', cur.onlineDate, t.onlineDate],
        ['下线日期', cur.offlineDate, t.offlineDate],
        ['适用范围', cur.target, t.target],
        ['销售渠道', cur.channels, t.channels],
        ['有效期限', cur.effective, t.effective],
        ['套餐内容', cur.usageJson, t.usageJson],
        ['其他说明', cur.extraJson, t.extraJson],
      ]
      for (const [field, before, after] of fieldMap) {
        if (before !== after) {
          changes.push({
            field,
            before: before && before.length > 80 ? before.slice(0, 80) + '…' : before,
            after: after && after.length > 80 ? after.slice(0, 80) + '…' : after,
          })
        }
      }
      if (changes.length) {
        stmts.push(
          env.DB.prepare(
            updateSql(
              [
                'name = ?',
                'price = ?',
                'priceValue = ?',
                'onlineDate = ?',
                'offlineDate = ?',
                'target = ?',
                'channels = ?',
                'effective = ?',
                'requirement = ?',
                'unsubscribe = ?',
                'liability = ?',
                'usageJson = ?',
                'extraJson = ?',
                'contentHash = ?',
                'missCount = 0',
                'lastSeenAt = ?',
              ],
              t.code
            )
          ).bind(
            t.name,
            t.price,
            t.priceValue,
            t.onlineDate,
            t.offlineDate,
            t.target,
            t.channels,
            t.effective,
            t.requirement,
            t.unsubscribe,
            t.liability,
            t.usageJson,
            t.extraJson,
            t.contentHash,
            now
          )
        )
        updated++
        addEvent({
          date: today,
          type: 'UPDATED',
          source: 'sync',
          tariffCode: t.code,
          tariffName: t.name,
          category: t.category,
          changedFields: JSON.stringify(changes),
          summary: `「${t.name}」内容更新（${changes.length} 项变更）`,
        })
      }
    }
    // 内容无变化但此前有 miss（曾连续未见到）：归零计数，无事件（仅计数写）
    if (cur && cur.status === 'ONLINE' && cur.contentHash === t.contentHash && (cur.missCount ?? 0) > 0) {
      stmts.push(env.DB.prepare(updateSql(['missCount = 0'], t.code)))
    }
    // 无变化：跳过其余写入（D1 行写优化），lastSeenAt 语义 =「内容最后确认」
  }

  // 下线检测（二次确认）：数据库有但本次抓取没有的 → missCount+1；
  // 连续达到阈值才 OFFLINE + REMOVED 事件，否则保持 ONLINE 仅累加计数（无事件）
  const incomingCodes = new Set(incoming.map((t) => t.code))
  for (const cur of existing.results) {
    if (!incomingCodes.has(cur.code) && cur.status === 'ONLINE') {
      const miss = (cur.missCount ?? 0) + 1
      if (miss >= REMOVED_MISS_THRESHOLD) {
        stmts.push(
          env.DB.prepare(updateSql(['status = ?', 'removedAt = ?', 'missCount = 0'], cur.code)).bind(
            'OFFLINE',
            now
          )
        )
        removed++
        addEvent({
          date: today,
          type: 'REMOVED',
          source: 'sync',
          tariffCode: cur.code,
          tariffName: cur.name,
          category: cur.category,
          summary: `「${cur.name}」已从公示页下线（连续 ${miss} 个快照日未见）`,
        })
      } else {
        // 单次未见：仅累加计数，保持 ONLINE，不产生事件
        stmts.push(
          env.DB.prepare(updateSql(['missCount = ?'], cur.code)).bind(miss)
        )
        pendingMiss++
      }
    }
  }

  // 批量提交（单事务语义；分块防超大事务）
  const BATCH = 400
  for (let i = 0; i < stmts.length; i += BATCH) {
    await env.DB.batch(stmts.slice(i, i + BATCH))
  }

  return { added, removed, updated, pendingMiss }
}

/** POST /api/sync */
async function handleSyncPost(env: Env, request: Request) {
  const auth = verifySyncToken(request, env)
  if (!auth.ok) return errJson(auth.reason || '鉴权失败', 401)

  const runId = uuid()
  await env.DB.prepare(
    `INSERT INTO SyncRun (id, startedAt, finishedAt, date, status, source, mode, totalBefore, totalAfter, added, removed, updated, message)
     VALUES (?,?,NULL,?,'RUNNING','manual','full',0,0,0,0,0,NULL)`
  )
    .bind(runId, nowIso(), todayStr())
    .run()

  try {
    const body = (await request.json().catch(() => ({}))) as { mode?: string; items?: unknown }
    const mode = body?.mode || 'items'

    if (mode !== 'items') {
      throw new Error('生产环境仅支持 items 远端直传（seed 模式为本地开发专用，Workers 无磁盘）')
    }
    const v = validateItems(body?.items)
    if (!v.ok) throw new Error(v.error || 'items 校验失败')
    const incoming = v.data!

    // 分类归零闸门：线上某分类在线 ≥ 20 条而本次抓取该分类为 0 —— 疑似采集端
    // 漏抓整类（2026-09-04 事故模式），拒绝本次同步（宁缺毋滥）
    {
      const prevCats = await env.DB.prepare(
        `SELECT category, COUNT(*) AS c FROM Tariff WHERE status = 'ONLINE' GROUP BY category`
      ).all<{ category: string; c: number }>()
      const incCats = new Set(incoming.map((t) => t.category))
      for (const g of prevCats.results || []) {
        if (g.c >= 20 && !incCats.has(g.category)) {
          throw new Error(
            `分类归零闸门：分类「${g.category}」线上在售 ${g.c} 条但本次抓取为 0，疑似漏抓，已拒绝本次同步`
          )
        }
      }
    }

    const result = await runDiffSync(env, incoming, runId)

    const totalAfter = await env.DB.prepare(`SELECT COUNT(*) AS c FROM Tariff WHERE status = 'ONLINE'`).first<{
      c: number
    }>()

    await env.DB.prepare(
      `UPDATE SyncRun SET status = 'SUCCESS', finishedAt = ?, source = 'scraper', totalAfter = ?,
        added = ?, removed = ?, updated = ?, message = ? WHERE id = ?`
    )
      .bind(
        nowIso(),
        totalAfter?.c ?? 0,
        result.added,
        result.removed,
        result.updated,
        `同步完成：抓取 ${incoming.length} 条（+${result.added} / -${result.removed} / ~${result.updated}）` +
          (result.pendingMiss > 0 ? `；${result.pendingMiss} 条连续未见待二次确认` : ''),
        runId
      )
      .run()

    const finished = await env.DB.prepare(`SELECT * FROM SyncRun WHERE id = ?`).bind(runId).first()

    return json({ success: true, data: { run: finished } })
  } catch (e) {
    const msg = e instanceof Error ? e.message : '同步失败'
    await env.DB.prepare(`UPDATE SyncRun SET status = 'FAILED', finishedAt = ?, message = ? WHERE id = ?`)
      .bind(nowIso(), msg, runId)
      .run()
    return errJson(msg)
  }
}

/* ══════════════════════════ 路由分发 ══════════════════════════ */

export const onRequest = async (context: FnContext): Promise<Response> => {
  const { request, env } = context
  const url = new URL(request.url)
  const path = (context.params?.path as string[] | undefined)?.join('/') ?? ''
  const sp = url.searchParams

  try {
    if (request.method === 'GET') {
      if (path === '') return handleRoot()
      if (path === 'stats') return await handleStats(env)
      if (path === 'timeline') return await handleTimeline(env, sp)
      if (path === 'timeline/heatmap') return await handleHeatmap(env, sp)
      if (path === 'tariffs') return await handleTariffs(env, sp)
      if (path.startsWith('tariffs/')) {
        return await handleTariffDetail(env, decodeURIComponent(path.slice('tariffs/'.length)))
      }
      if (path === 'upcoming') return await handleUpcoming(env, sp)
      if (path === 'insights') return await handleInsights(env)
      if (path === 'export') {
        return sp.get('kind') === 'events' ? await exportEventsCsv(env, sp) : await exportTariffsCsv(env, sp)
      }
      if (path === 'feed') return await handleFeed(env, sp, url.origin)
      if (path === 'sync') return await handleSyncRuns(env, 30)
      if (path === 'sync/runs') return await handleSyncRuns(env, 50)
      return errJson('接口不存在', 404)
    }

    if (request.method === 'POST') {
      if (path === 'sync') return await handleSyncPost(env, request)
      return errJson('接口不存在', 404)
    }

    return errJson('方法不允许', 405)
  } catch (e) {
    console.error('api error', path, e)
    return errJson('服务器内部错误', 500)
  }
}
