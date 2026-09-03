import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** GET /api/tariffs/[code] — 资费详情 + 变更历史 + 相似资费推荐 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params
    const tariff = await db.tariff.findUnique({ where: { code } })
    if (!tariff) {
      return NextResponse.json({ success: false, error: '未找到该资费' }, { status: 404 })
    }
    const events = await db.changeEvent.findMany({
      where: { tariffCode: code },
      orderBy: { date: 'desc' },
    })

    /* 相似资费推荐：同分类 + 在售，综合评分排序
       评分 = 价格相近度（±40% 内，价差越小分越高）
            + 同适用人群 +15（用户群体一致）
            + 同销售渠道 +8（购买方式一致）
            + 上线时间相近 +5（同期产品） */
    const candidates = await db.tariff.findMany({
      where: {
        code: { not: code },
        category: tariff.category,
        status: 'ONLINE',
        ...(tariff.scope ? { scope: tariff.scope } : {}),
      },
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
      },
      take: 200,
    })

    interface Scored {
      code: string
      name: string
      category: string
      price: string | null
      priceValue: number | null
      onlineDate: string | null
      offlineDate: string | null
      target: string | null
      channels: string | null
      matchTags: string[]
      score: number
    }

    const scored: Scored[] = candidates.map((t) => {
      const tags: string[] = []
      let score = 0

      if (tariff.priceValue !== null && t.priceValue !== null) {
        const base = tariff.priceValue
        const ratio = Math.abs(t.priceValue - base) / Math.max(base, 1)
        if (ratio <= 0.4) {
          // 价格相近：0-40 分（越近越高）
          score += 40 * (1 - ratio / 0.4)
          if (ratio === 0) tags.push('同价')
          else if (ratio <= 0.1) tags.push('价差±10%')
        } else {
          score -= (ratio - 0.4) * 20 // 超出 ±40% 轻微降权但不硬过滤
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

    // 有价格的基准资费：优先价格相近；无价格基准：价格信息权重为零，靠人群/渠道/时间排序
    const similar = scored
      .sort((a, b) => {
        // 价差超出 ±40% 且无基准价兜底时排后
        if (tariff.priceValue !== null) {
          const inRangeA = a.priceValue !== null && Math.abs(a.priceValue - tariff.priceValue) / Math.max(tariff.priceValue, 1) <= 0.4
          const inRangeB = b.priceValue !== null && Math.abs(b.priceValue - tariff.priceValue) / Math.max(tariff.priceValue, 1) <= 0.4
          if (inRangeA !== inRangeB) return inRangeA ? -1 : 1
        }
        return b.score - a.score
      })
      .slice(0, 6)
      .map(({ matchTags, ...rest }) => ({ ...rest, matchTags }))

    return NextResponse.json({ success: true, data: { tariff, events, similar } })
  } catch (e) {
    console.error('tariff detail error', e)
    return NextResponse.json({ success: false, error: '详情获取失败' }, { status: 500 })
  }
}
