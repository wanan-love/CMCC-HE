'use client'

import { useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Scale, Check, X, Sparkles, Download } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { ApiResponse, TariffDetail, UsageItem } from './types'
import { CATEGORY_COLORS, formatDateCN, daysUntil } from './types'

async function fetchDetail(code: string): Promise<TariffDetail> {
  const res = await fetch(`/api/tariffs/${encodeURIComponent(code)}`)
  const json = (await res.json()) as ApiResponse<{ tariff: TariffDetail }>
  if (!json.success) throw new Error(json.error || '请求失败')
  return json.data.tariff
}

function useDetails(codes: string[]) {
  return useQuery({
    queryKey: ['compare', codes.join(',')],
    queryFn: async () => Promise.all(codes.map(fetchDetail)),
    enabled: codes.length > 0,
    staleTime: 60_000,
  })
}

function parseUsage(t: TariffDetail | undefined): UsageItem[] {
  if (!t) return []
  try {
    return JSON.parse(t.usageJson || '[]') as UsageItem[]
  } catch {
    return []
  }
}

export interface CompareRow {
  label: string
  values: (string | null)[]
  highlight: boolean
}

/** 把对比表序列化为 CSV（BOM + 字段转义；与页面对比表同构） */
function buildCompareCsv(
  tariffs: TariffDetail[],
  rows: CompareRow[],
  badges: (string | null)[]
): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v).replace(/"/g, '""').replace(/[\r\n]+/g, ' ')
    return `"${s}"`
  }
  const lines: string[] = []
  // 表头：字段名 + 各资费「名称（编号）」
  lines.push(['对比字段', ...tariffs.map((t) => `${t.name}（${t.code}）`)].map(esc).join(','))
  // 概览行：分类 / 在售状态 / 智能徽章（与表格头部徽章对应）
  lines.push(['分类', ...tariffs.map((t) => t.category)].map(esc).join(','))
  lines.push(
    ['在售状态', ...tariffs.map((t) => (t.status === 'ONLINE' ? '在售' : '已下线'))].map(esc).join(',')
  )
  lines.push(['智能徽章', ...badges].map(esc).join(','))
  // 对比字段行（与页面表格一致，含差异高亮标记 ※）
  for (const row of rows) {
    lines.push(
      [row.highlight ? `※${row.label}` : row.label, ...row.values].map(esc).join(',')
    )
  }
  return '\uFEFF' + lines.join('\r\n')
}

export function CompareDialog({
  codes,
  onOpenChange,
  onSelectTariff,
}: {
  codes: string[]
  onOpenChange: (open: boolean) => void
  onSelectTariff: (code: string) => void
}) {
  const { data, isLoading } = useDetails(codes)
  const tariffs = data ?? []
  const [exporting, setExporting] = useState(false)

  // 合并所有套餐内容的 label 集合（保持顺序）
  const usageLabels = useMemo(() => {
    const seen = new Set<string>()
    for (const t of tariffs) {
      for (const u of parseUsage(t)) seen.add(u.label)
    }
    return [...seen]
  }, [tariffs])

  const rows: CompareRow[] = useMemo(() => {
    const mk = (label: string, get: (t: TariffDetail) => string | null): CompareRow => {
      const values = tariffs.map(get)
      const nonNull = values.filter((v) => v !== null && v !== '')
      const highlight = nonNull.length >= 2 && new Set(nonNull).size > 1
      return { label, values, highlight }
    }
    const rows: CompareRow[] = [
      mk('资费标准', (t) => t.price),
      mk('上线日期', (t) => (t.onlineDate ? formatDateCN(t.onlineDate) : null)),
      mk(
        '下线日期',
        (t) => (t.offlineDate ? formatDateCN(t.offlineDate) : null)
      ),
      mk('剩余天数', (t) => {
        const d = daysUntil(t.offlineDate)
        return d === null ? null : `${d} 天`
      }),
      mk('适用范围', (t) => t.target),
      mk('销售渠道', (t) => t.channels),
      mk('有效期限', (t) => t.effective),
      mk('在网要求', (t) => t.requirement),
      mk('退订方式', (t) => t.unsubscribe),
    ]
    for (const label of usageLabels) {
      rows.push(
        mk(label, (t) => parseUsage(t).find((u) => u.label === label)?.value ?? null)
      )
    }
    return rows
  }, [tariffs, usageLabels])

  const cheapest = useMemo(() => {
    if (tariffs.length < 2) return -1
    const prices = tariffs.map((t) => t.priceValue ?? Infinity)
    const min = Math.min(...prices)
    return prices.findIndex((p) => p === min)
  }, [tariffs])

  const longest = useMemo(() => {
    if (tariffs.length < 2) return -1
    const days = tariffs.map((t) => daysUntil(t.offlineDate) ?? -Infinity)
    const max = Math.max(...days)
    return days.findIndex((d) => d === max)
  }, [tariffs])

  /** 导出对比结果 CSV（客户端生成：数据已在内存，BOM 保证 Excel 中文不乱码） */
  const handleExportCsv = async () => {
    if (!tariffs.length) return
    setExporting(true)
    try {
      const badges = tariffs.map((t, i) => {
        const list: string[] = []
        if (i === cheapest && t.priceValue !== null) list.push('最便宜')
        if (i === longest && t.offlineDate) list.push('在售更久')
        return list.join('、') || null
      })
      const csv = buildCompareCsv(tariffs, rows, badges)
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `tariff-compare-${codes.join('-')}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.success(`已导出 ${tariffs.length} 个资费的对比结果 CSV`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  return (
    <Dialog open={codes.length > 0} onOpenChange={(o) => !o && onOpenChange(false)}>
      {/* sm:max-w-4xl! 用 important 修饰符压过基础组件的 sm:max-w-lg（同为 max-width 时
          媒体查询层的后者在源码序中胜出，导致 max-w-4xl 意图从未生效，桌面实际 512px） */}
      <DialogContent className="max-w-4xl sm:max-w-4xl! max-h-[88vh] p-0 gap-0">
        {/* 原为 Radix ScrollArea，但其 Viewport 内层 display:table 会随宽表格撑破容器宽度
            （移动端 375px 下 p-5 实测被撑到 568px、内容裁切且无法横滚）；
            改为原生 overflow 容器：纵向滚外层 + 横向滚表格自身，宽度约束恢复生效 */}
        <div className="max-h-[88vh] overflow-y-auto overscroll-contain">
          <div className="p-5">
            <DialogHeader className="text-left space-y-1.5 pb-1">
              <DialogTitle className="flex items-center gap-2 text-lg flex-wrap">
                <Scale className="size-5 text-emerald-600" />
                资费对比
                <Badge variant="outline" className="text-xs font-normal text-stone-500">
                  {codes.length} 个资费
                </Badge>
                <button
                  onClick={handleExportCsv}
                  disabled={exporting || isLoading || tariffs.length < 2}
                  title={tariffs.length < 2 ? '至少对比 2 个资费后可导出' : '导出当前对比结果为 CSV'}
                  aria-label="导出对比结果 CSV"
                  className="ml-auto inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-emerald-200 bg-emerald-50 text-emerald-700 text-xs font-medium hover:bg-emerald-100 hover:border-emerald-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Download className="size-3.5" />
                  导出对比 CSV
                </button>
              </DialogTitle>
              <DialogDescription>
                不同字段已高亮标记，点击表头资费名可查看完整详情
              </DialogDescription>
            </DialogHeader>

            {isLoading ? (
              <div className="space-y-3 pt-3">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-64 w-full" />
              </div>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm border-separate border-spacing-0">
                  <thead>
                    <tr>
                      <th className="sticky left-0 z-10 bg-white w-28 min-w-28 p-2 text-left text-xs text-stone-400 font-normal">
                        对比字段
                      </th>
                      {tariffs.map((t, i) => (
                        <th
                          key={t.code}
                          className="p-2 text-left align-top min-w-52 cursor-pointer hover:bg-stone-50 rounded-t-lg"
                          onClick={() => {
                            onOpenChange(false)
                            onSelectTariff(t.code)
                          }}
                        >
                          <div className="flex flex-wrap gap-1 mb-1">
                            <Badge
                              variant="outline"
                              className={`text-[10px] ${CATEGORY_COLORS[t.category] ?? CATEGORY_COLORS['其他']}`}
                            >
                              {t.category}
                            </Badge>
                            {i === cheapest && t.priceValue !== null && (
                              <Badge className="text-[10px] bg-emerald-100 text-emerald-700 border border-emerald-200 hover:bg-emerald-100">
                                <Sparkles className="size-2.5 mr-0.5" />最便宜
                              </Badge>
                            )}
                            {i === longest && t.offlineDate && (
                              <Badge className="text-[10px] bg-teal-100 text-teal-700 border border-teal-200 hover:bg-teal-100">
                                在售更久
                              </Badge>
                            )}
                          </div>
                          <div className="font-semibold text-stone-800 text-sm leading-snug">
                            {t.name}
                          </div>
                          <div className="text-[11px] text-stone-400 font-mono mt-0.5">{t.code}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.label} className={row.highlight ? 'bg-amber-50/70' : ''}>
                        <td className="sticky left-0 z-10 p-2 text-xs text-stone-500 border-t border-stone-100 bg-inherit whitespace-nowrap">
                          {row.highlight && (
                            <span className="inline-block size-1.5 rounded-full bg-amber-400 mr-1 align-middle" />
                          )}
                          {row.label}
                        </td>
                        {row.values.map((v, i) => (
                          <td
                            key={i}
                            className="p-2 border-t border-stone-100 align-top text-xs"
                          >
                            {v === null || v === '' ? (
                              <span className="text-stone-300">—</span>
                            ) : row.highlight ? (
                              <span className="font-semibold text-amber-800">{v}</span>
                            ) : (
                              <span className="text-stone-600">{v}</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-3 flex items-center gap-2 text-[11px] text-stone-400">
              <Check className="size-3 text-amber-500" />
              高亮行表示所选资费之间存在差异
              <X className="size-3 text-stone-300 ml-2" />
              — 表示该资费无此项内容
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
