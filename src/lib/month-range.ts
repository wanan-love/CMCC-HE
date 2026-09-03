/** 把 YYYY-MM 解析为 [月初, 次月初) 的日期区间（非法返回 null） */
export function parseMonthRange(month: string): { gte: string; lt: string } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null
  const [y, m] = month.split('-').map(Number)
  if (m < 1 || m > 12) return null
  const nextY = m === 12 ? y + 1 : y
  const nextM = m === 12 ? 1 : m + 1
  return { gte: `${month}-01`, lt: `${nextY}-${String(nextM).padStart(2, '0')}-01` }
}

/** 把 YYYY 解析为 [年初, 次年初) 的日期区间（非法返回 null）——年度下钻用 */
export function parseYearRange(year: string): { gte: string; lt: string } | null {
  if (!/^\d{4}$/.test(year)) return null
  const y = Number(year)
  if (y < 1990 || y > 2100) return null
  return { gte: `${year}-01-01`, lt: `${y + 1}-01-01` }
}

/** 把 YYYY-MM 格式化为中文月份（2026-08 → 2026年8月） */
export function formatMonthCN(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) return month
  return `${m[1]}年${parseInt(m[2], 10)}月`
}

/** 月份加减 N（2026-01 + (-1) → 2025-12；2026-12 + 1 → 2027-01）。非法输入原样返回 */
export function shiftMonth(month: string, delta: number): string {
  if (!/^\d{4}-\d{2}$/.test(month)) return month
  const [y, m] = month.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  const ny = Math.floor(total / 12)
  const nm = ((total % 12) + 12) % 12 + 1
  return `${ny}-${String(nm).padStart(2, '0')}`
}

/** 数据集中最早的月份（YYYY-MM，无事件返回 null）——翻月的下界 */
export function earliestMonth(minDate: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(minDate)) return null
  return minDate.slice(0, 7)
}
