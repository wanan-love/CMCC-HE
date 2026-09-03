/**
 * 相对时间与数据新鲜度（「采集与展示分离」架构的最后更新时间展示）
 *
 * 架构背景：抓取（GitHub Actions 每日北京时间 04:00）与展示（本站）分离，
 * 页面无法也不需要手动触发更新，只展示「最后更新时间」与新鲜度状态。
 */

/** 相对时间：<1min 刚刚 / <1h N 分钟前 / <24h N 小时前 / <7d N 天前 / 更早则日期 */
export function formatRelativeTime(
  iso: string | null | undefined,
  now: Date = new Date()
): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const diffMs = now.getTime() - t
  if (diffMs < 60_000) return '刚刚'
  const min = Math.floor(diffMs / 60_000)
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} 天前`
  return formatDateShort(t)
}

/** 绝对时间 YYYY-MM-DD HH:mm（title 提示用，本地时区） */
export function formatDateTimeCN(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** HH:mm（同步记录行的运行时刻） */
export function formatTimeShort(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatDateShort(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 数据新鲜度：抓取节奏为每日 1 次（04:00），26 小时内算「新鲜」。
 * 超过则提示数据可能未按期更新（公示页改版 / Actions 失败等）。
 */
export function isDataFresh(iso: string | null | undefined, now: Date = new Date()): boolean {
  if (!iso) return false
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return false
  return now.getTime() - t < 26 * 3600_000
}

/**
 * 数据严重过期（>48 小时未更新）：升级为页面级警示条。
 * 与 isDataFresh（26h 点亮黄点）分级：26-48h 仅指示器变色，>48h 弹出可关闭警示条。
 */
export function isDataStale(iso: string | null | undefined, now: Date = new Date()): boolean {
  if (!iso) return false
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return false
  return now.getTime() - t > 48 * 3600_000
}

/** 过期小时数（警示条文案用；不足 1 小时按 1 计） */
export function staleHours(iso: string | null | undefined, now: Date = new Date()): number {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 0
  return Math.max(1, Math.floor((now.getTime() - t) / 3600_000))
}

/** 下次抓取提示（每日 04:00，北京时间），返回 "约 N 小时后" */
export function hoursUntilNextUpdate(now: Date = new Date()): number {
  const next = new Date(now)
  next.setHours(4, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return Math.max(1, Math.round((next.getTime() - now.getTime()) / 3600_000))
}
