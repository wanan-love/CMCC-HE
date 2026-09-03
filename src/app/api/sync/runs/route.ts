import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** GET /api/sync/runs — 同步运行历史 */
export async function GET(_req: NextRequest) {
  try {
    const runs = await db.syncRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 50,
    })
    return NextResponse.json({ success: true, data: { runs } })
  } catch (e) {
    console.error('sync runs error', e)
    return NextResponse.json({ success: false, error: '同步历史获取失败' }, { status: 500 })
  }
}
