import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parseMonthRange, parseYearRange } from '@/lib/month-range'
import { parseAdvFilters, advEventWhere, advTariffWhere } from '@/lib/adv-filter'

export const dynamic = 'force-dynamic'

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

/**
 * GET /api/export — 数据导出 CSV
 * - 默认：导出资费库（参数与 /api/tariffs 一致：status/category/scope/q/priceMin/priceMax）
 * - kind=events：导出变更事件（参数与 /api/timeline 一致：days/category/type/source/q/date/month/year）
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams
    const kind = sp.get('kind') || ''
    if (kind === 'events') {
      return exportEventsCsv(sp)
    }
    return exportTariffsCsv(sp)
  } catch (e) {
    console.error('export error', e)
    return NextResponse.json({ success: false, error: '导出失败' }, { status: 500 })
  }
}

/** 导出变更事件 CSV（与 /api/timeline 同款筛选含高级筛选，上限 5000 条） */
async function exportEventsCsv(sp: URLSearchParams): Promise<NextResponse> {
  const days = sp.get('days') || ''
  const category = sp.get('category') || ''
  const type = sp.get('type') || ''
  const source = sp.get('source') || ''
  const q = (sp.get('q') || '').trim()
  const date = sp.get('date') || ''
  const month = (sp.get('month') || '').trim()
  const year = (sp.get('year') || '').trim()
  const adv = parseAdvFilters(sp)

  const where: Record<string, unknown> = {}
  const monthRange = parseMonthRange(month)
  const yearRange = parseYearRange(year)
  if (date) {
    where.date = date
  } else if (monthRange) {
    where.date = monthRange
  } else if (yearRange) {
    where.date = yearRange
  } else if (days && days !== 'all') {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - parseInt(days))
    where.date = { gte: cutoff.toISOString().slice(0, 10) }
  }
  if (type) where.type = type
  if (source) where.source = source
  // 高级筛选（catIn/catOut/content/priceMin/priceMax）
  Object.assign(where, advEventWhere(adv, category))
  if (q) {
    where.OR = [
      { tariffName: { contains: q } },
      { tariffCode: { contains: q } },
    ]
  }

  const events = await db.changeEvent.findMany({
    where,
    orderBy: [{ date: 'desc' }, { type: 'asc' }],
    include: {
      tariff: {
        select: { price: true, scope: true, range: true, target: true, channels: true, onlineDate: true, offlineDate: true },
      },
    },
    take: 5000,
  })

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
  for (const e of events) {
    let detail = ''
    if (e.changedFields) {
      try {
        const changes = JSON.parse(e.changedFields) as { field: string; before: string | null; after: string | null }[]
        detail = changes.map((c) => `${c.field}: ${c.before ?? '—'} → ${c.after ?? '—'}`).join('；')
      } catch {
        /* ignore */
      }
    }
    lines.push(
      [
        e.date,
        typeLabels[e.type] ?? e.type,
        e.tariffCode ?? '',
        e.tariffName,
        e.category ?? '',
        e.tariff?.price ?? '',
        e.tariff?.scope ?? '',
        e.tariff?.range ?? '',
        e.tariff?.channels ?? '',
        e.tariff?.onlineDate ?? '',
        e.tariff?.offlineDate ?? '',
        e.source,
        e.summary ?? '',
        detail,
      ]
        .map(csvEscape)
        .join(',')
    )
  }

  const csv = lines.join('\r\n')
  const dateStr = new Date().toISOString().slice(0, 10)
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="tariff-events-${dateStr}.csv"`,
    },
  })
}

/** 导出资费库 CSV（与 /api/tariffs 同款筛选含高级筛选） */
async function exportTariffsCsv(sp: URLSearchParams): Promise<NextResponse> {
    const status = sp.get('status') || ''
    const category = sp.get('category') || ''
    const scope = sp.get('scope') || ''
    const q = (sp.get('q') || '').trim()
    const adv = parseAdvFilters(sp)

    const where: Record<string, unknown> = {}
    if (status) where.status = status
    if (scope) where.scope = scope
    // 高级筛选（catIn/catOut/content/priceMin/priceMax；与单选 category 合并）
    Object.assign(where, advTariffWhere(adv, category))
    if (q) {
      where.OR = [
        { name: { contains: q } },
        { code: { contains: q } },
        { target: { contains: q } },
      ]
    }

    const items = await db.tariff.findMany({
      where,
      orderBy: [{ onlineDate: 'desc' }, { firstSeenAt: 'desc' }],
      take: 5000,
    })

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
    for (const t of items) {
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

    const csv = lines.join('\r\n')
    const dateStr = new Date().toISOString().slice(0, 10)
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="hebei-tariffs-${dateStr}.csv"`,
      },
    })
}
