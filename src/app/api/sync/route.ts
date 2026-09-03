import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { timingSafeEqual } from 'crypto'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SEED_FILE = join(process.cwd(), 'seed', 'tariffs.normalized.json')

/** 单次同步允许的最大条目数（防滥用，正常抓取约 3.1k 条） */
const MAX_ITEMS = 10000

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

/**
 * 同步令牌校验：
 * - 生产（Cloudflare Pages / Vercel）通过环境变量 SYNC_TOKEN 配置密钥；
 *   未配置时视为本地开发模式，放行（便于沙箱/本地调试）。
 * - 支持三种传法：Authorization: Bearer <token> / x-sync-token 头 / ?token= 查询参数。
 * - timingSafeEqual 防时序攻击。
 */
function verifySyncToken(req: NextRequest): { ok: boolean; reason?: string } {
  const token = process.env.SYNC_TOKEN
  if (!token) return { ok: true }
  const auth = req.headers.get('authorization') || ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  const header = (req.headers.get('x-sync-token') || '').trim()
  const query = (req.nextUrl.searchParams.get('token') || '').trim()
  const provided = bearer || header || query
  if (!provided) return { ok: false, reason: '缺少同步令牌（Authorization: Bearer <token>）' }
  const a = Buffer.from(provided)
  const b = Buffer.from(token)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: '同步令牌不正确' }
  }
  return { ok: true }
}

/** 校验远端直传的资费数组（结构 + 数量 + 必填字段） */
function validateItems(items: unknown): { ok: boolean; data?: IncomingTariff[]; error?: string } {
  if (!Array.isArray(items)) return { ok: false, error: 'items 必须是数组' }
  if (items.length === 0) return { ok: false, error: 'items 不能为空' }
  if (items.length > MAX_ITEMS) return { ok: false, error: `items 超过上限 ${MAX_ITEMS} 条` }
  const REQUIRED_STR: (keyof IncomingTariff)[] = ['code', 'name', 'category', 'scope', 'range', 'usageJson', 'extraJson', 'contentHash']
  const cleaned: IncomingTariff[] = []
  for (const it of items) {
    if (typeof it !== 'object' || it === null) return { ok: false, error: 'items 内含非对象条目' }
    const t = it as Record<string, unknown>
    for (const key of REQUIRED_STR) {
      if (typeof t[key] !== 'string' || !(t[key] as string).trim()) {
        return { ok: false, error: `条目缺少必填字段 ${String(key)}` }
      }
    }
    if (t.code.length > 64 || t.name.length > 256) return { ok: false, error: 'code/name 字段过长' }
    cleaned.push({
      code: t.code,
      name: t.name,
      category: t.category,
      scope: t.scope,
      range: t.range,
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
      usageJson: t.usageJson,
      extraJson: t.extraJson,
      contentHash: t.contentHash,
    })
  }
  return { ok: true, data: cleaned }
}

/** GET /api/sync — 同步运行记录（只读，公开） */
export async function GET() {
  try {
    const runs = await db.syncRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 30,
      select: {
        id: true,
        startedAt: true,
        finishedAt: true,
        date: true,
        status: true,
        source: true,
        mode: true,
        totalBefore: true,
        totalAfter: true,
        added: true,
        removed: true,
        updated: true,
        message: true,
      },
    })
    return NextResponse.json({ success: true, data: { runs } })
  } catch (e) {
    console.error('sync list error', e)
    return NextResponse.json({ success: false, error: '同步记录获取失败' }, { status: 500 })
  }
}

/**
 * POST /api/sync — 触发同步（需令牌，见 verifySyncToken）
 * body: { mode: 'seed' | 'items', items?: IncomingTariff[] }
 *  - seed : 重新导入本地 seed/tariffs.normalized.json（本地/沙箱调试用）
 *  - items: 远端抓取直传（GitHub Action 每日任务将抓取结果 POST 到这里）
 * 两种模式共用同一套差异对比引擎（新增上线 / 检测下线 / 识别字段变更）。
 */
export async function POST(req: NextRequest) {
  const auth = verifySyncToken(req)
  if (!auth.ok) {
    return NextResponse.json(
      { success: false, error: auth.reason || '鉴权失败' },
      { status: 401 }
    )
  }

  const run = await db.syncRun.create({
    data: {
      date: new Date().toISOString().slice(0, 10),
      status: 'RUNNING',
      source: 'manual',
      mode: 'full',
    },
  })
  try {
    const body = await req.json().catch(() => ({}))
    const mode: string = body?.mode || 'seed'

    let incoming: IncomingTariff[]
    let source = 'seed-import'

    if (mode === 'items') {
      const v = validateItems(body?.items)
      if (!v.ok) throw new Error(v.error || 'items 校验失败')
      incoming = v.data!
      source = 'scraper'
    } else {
      if (!existsSync(SEED_FILE)) {
        throw new Error('未找到种子数据文件，请先运行抓取脚本')
      }
      incoming = JSON.parse(readFileSync(SEED_FILE, 'utf-8'))
    }

    const result = await runDiffSync(incoming)

    const totalAfter = await db.tariff.count({ where: { status: 'ONLINE' } })
    const finished = await db.syncRun.update({
      where: { id: run.id },
      data: {
        status: 'SUCCESS',
        finishedAt: new Date(),
        source,
        totalAfter,
        added: result.added,
        removed: result.removed,
        updated: result.updated,
        message: `同步完成：抓取 ${incoming.length} 条（+${result.added} / -${result.removed} / ~${result.updated}）`,
      },
    })

    return NextResponse.json({ success: true, data: { run: finished } })
  } catch (e) {
    console.error('sync error', e)
    const msg = e instanceof Error ? e.message : '同步失败'
    await db.syncRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', finishedAt: new Date(), message: msg },
    })
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

/**
 * 差异同步引擎：incoming vs 数据库当前状态
 *
 * D1 读写优化（D1 按行数计费，行内容多少不计费）：
 *  1. 全表读一次仅取 diff 所需列（约 3100 行/天，免费额度 500 万行读/天，占比 <0.1%）
 *  2. 「无变化」的资费不逐行刷 lastSeenAt —— 避免每天 3100+ 行写入；
 *     lastSeenAt 语义 =「内容最后一次确认」，仅真实变更时刷新（每天通常 0~50 行写）
 *  3. 事件、资费变更攒批后 createMany/updateMany 单事务提交（1 次往返）
 */
async function runDiffSync(incoming: IncomingTariff[]) {
  const today = new Date().toISOString().slice(0, 10)

  // 只取 diff 所需列（排除 province/range/scope 等不变列与 id/firstSeenAt/lastSeenAt）
  const existing = await db.tariff.findMany({
    select: {
      code: true,
      name: true,
      category: true,
      price: true,
      priceValue: true,
      onlineDate: true,
      offlineDate: true,
      target: true,
      channels: true,
      effective: true,
      requirement: true,
      unsubscribe: true,
      liability: true,
      usageJson: true,
      extraJson: true,
      contentHash: true,
      status: true,
    },
  })
  const byCode = new Map(existing.map((t) => [t.code, t]))

  let added = 0
  let removed = 0
  let updated = 0

  interface TariffCreateRow {
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
    firstSeenAt: Date
    lastSeenAt: Date
    status: string
  }
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

  const toCreate: TariffCreateRow[] = []
  const addEvents: EventRow[] = []
  const toUpdate: { code: string; data: Record<string, unknown> }[] = []
  const updateEvents: EventRow[] = []
  const offEvents: EventRow[] = []

  const now = new Date()

  // 新增 / 更新
  for (const t of incoming) {
    const cur = byCode.get(t.code)
    if (!cur) {
      toCreate.push({
        code: t.code,
        name: t.name,
        category: t.category,
        scope: t.scope,
        range: t.range,
        province: t.province,
        price: t.price,
        priceValue: t.priceValue,
        onlineDate: t.onlineDate,
        offlineDate: t.offlineDate,
        target: t.target,
        channels: t.channels,
        effective: t.effective,
        requirement: t.requirement,
        unsubscribe: t.unsubscribe,
        liability: t.liability,
        usageJson: t.usageJson,
        extraJson: t.extraJson,
        contentHash: t.contentHash,
        firstSeenAt: now,
        lastSeenAt: now,
        status: 'ONLINE',
      })
      addEvents.push({
        date: today,
        type: 'ADDED',
        source: 'sync',
        tariffCode: t.code,
        tariffName: t.name,
        category: t.category,
        summary: `新资费上线「${t.name}」（${t.price ?? '价格未公示'}）`,
      })
    } else if (cur.status === 'OFFLINE') {
      // 重新上线：此前标记下线，但本次抓取又出现了
      toUpdate.push({
        code: t.code,
        data: {
          status: 'ONLINE',
          removedAt: null,
          lastSeenAt: now,
          contentHash: t.contentHash,
          name: t.name,
          price: t.price,
          priceValue: t.priceValue,
          onlineDate: t.onlineDate,
          offlineDate: t.offlineDate,
        },
      })
      addEvents.push({
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
        toUpdate.push({
          code: t.code,
          data: {
            name: t.name,
            price: t.price,
            priceValue: t.priceValue,
            onlineDate: t.onlineDate,
            offlineDate: t.offlineDate,
            target: t.target,
            channels: t.channels,
            effective: t.effective,
            requirement: t.requirement,
            unsubscribe: t.unsubscribe,
            liability: t.liability,
            usageJson: t.usageJson,
            extraJson: t.extraJson,
            contentHash: t.contentHash,
            lastSeenAt: now,
          },
        })
        updateEvents.push({
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
    // 无变化：跳过写入（D1 行写优化），lastSeenAt 语义为「内容最后确认」
  }

  // 下线检测：数据库有但本次抓取没有的
  const incomingCodes = new Set(incoming.map((t) => t.code))
  const toOffline: string[] = []
  for (const cur of existing) {
    if (!incomingCodes.has(cur.code) && cur.status === 'ONLINE') {
      toOffline.push(cur.code)
      offEvents.push({
        date: today,
        type: 'REMOVED',
        source: 'sync',
        tariffCode: cur.code,
        tariffName: cur.name,
        category: cur.category,
        summary: `「${cur.name}」已从公示页下线`,
      })
    }
  }

  // 批量提交（D1：单事务批写，行数只算真实变更行）
  const BATCH = 500
  for (let i = 0; i < toCreate.length; i += BATCH) {
    await db.tariff.createMany({ data: toCreate.slice(i, i + BATCH) })
  }
  for (const u of toUpdate) {
    const { code, ...data } = u
    await db.tariff.update({ where: { code }, data })
  }
  if (toOffline.length) {
    await db.tariff.updateMany({
      where: { code: { in: toOffline } },
      data: { status: 'OFFLINE', removedAt: now },
    })
  }
  const allEvents = [...addEvents, ...updateEvents, ...offEvents]
  for (let i = 0; i < allEvents.length; i += BATCH) {
    await db.changeEvent.createMany({ data: allEvents.slice(i, i + BATCH) })
  }

  added = addEvents.length
  updated = updateEvents.length
  removed = offEvents.length

  return { added, removed, updated }
}
