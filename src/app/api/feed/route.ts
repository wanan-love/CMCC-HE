import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/feed — 订阅源（最近变更事件）
 * 默认 RSS 2.0 XML；?format=json 返回 JSON
 * 参数：days=30（回看天数）、limit=50（条数上限）、type=ADDED/REMOVED/UPDATED（可选过滤）、
 * category=套餐/加装包/营销活动/港澳台/国际资费（可选分类过滤）、
 * region=HEBEI（可选：仅看河北专属资费，即适用范围为「河北」的资费）
 * 排除 demo 演示事件，保证订阅内容真实。
 */

const VALID_CATEGORIES = ['套餐', '加装包', '营销活动', '港澳台/国际资费']
const VALID_REGIONS = ['HEBEI']

const TYPE_PREFIX: Record<string, string> = {
  ADDED: '🟢 上线',
  REMOVED: '🔴 下线',
  UPDATED: '🟡 变更',
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, ']]&gt;')}]]>`
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams
    const days = Math.min(Math.max(parseInt(sp.get('days') ?? '30', 10) || 30, 1), 365)
    const limit = Math.min(Math.max(parseInt(sp.get('limit') ?? '50', 10) || 50, 1), 200)
    const type = sp.get('type')
    const category = sp.get('category')
    const region = sp.get('region')
    const format = sp.get('format')

    const since = new Date()
    since.setDate(since.getDate() - days)
    const sinceStr = since.toISOString().slice(0, 10)

    const where: Record<string, unknown> = {
      date: { gte: sinceStr },
      source: { not: 'demo' },
    }
    if (type && ['ADDED', 'REMOVED', 'UPDATED'].includes(type)) {
      where.type = type
    }
    if (category && VALID_CATEGORIES.includes(category)) {
      where.category = category
    }
    if (region && VALID_REGIONS.includes(region)) {
      // 仅看河北专属资费：通过事件关联的资费记录过滤适用范围
      // （tariffCode 为空的事件无法判定地域，自然被排除）
      where.tariff = { range: '河北' }
    }

    const events = await db.changeEvent.findMany({
      where,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    })

    if (format === 'json') {
      return NextResponse.json({
        success: true,
        data: {
          title: '河北移动资费变更速递',
          description: `最近 ${days} 天中国移动资费公示变更（上线/下线/内容调整）`,
          generatedAt: new Date().toISOString(),
          days,
          count: events.length,
          filter: { type: type || null, category: category || null, region: region || null },
          items: events.map((e) => ({
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

    // RSS 2.0
    const siteUrl = req.nextUrl.origin
    const items = events
      .map((e) => {
        const prefix = TYPE_PREFIX[e.type] ?? '事件'
        const link = e.tariffCode ? `${siteUrl}/?tariff=${e.tariffCode}` : `${siteUrl}/?tab=timeline`
        let desc = e.summary ?? ''
        if (e.changedFields) {
          try {
            const fields: { field: string; before: string | null; after: string | null }[] = JSON.parse(e.changedFields)
            if (fields.length) {
              desc +=
                '\n\n' +
                fields
                  .map((f) => `・${f.field}：${f.before ?? '（空）'} → ${f.after ?? '（空）'}`)
                  .join('\n')
            }
          } catch {
            /* ignore */
          }
        }
        return `    <item>
      <title>${esc(`${prefix}｜${e.tariffName}`)}</title>
      <link>${esc(link)}</link>
      <guid isPermaLink="false">${esc(`${e.date}-${e.type}-${e.tariffCode ?? e.tariffName}`)}</guid>
      <pubDate>${new Date(e.date + 'T08:00:00+08:00').toUTCString()}</pubDate>
      <category>${esc(e.category ?? '资费')}</category>
      <description>${cdata(desc)}</description>
    </item>`
      })
      .join('\n')

    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>河北移动资费变更速递</title>
    <link>${esc(siteUrl)}</link>
    <description>每日对比中国移动资费公示页：资费上线、下线、内容调整尽在掌握</description>
    <language>zh-CN</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <ttl>720</ttl>
    <atom:link href="${esc(`${siteUrl}/api/feed`)}" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`

    return new NextResponse(rss, {
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=600',
      },
    })
  } catch (e) {
    console.error('feed error', e)
    return NextResponse.json({ success: false, error: '订阅源生成失败' }, { status: 500 })
  }
}
