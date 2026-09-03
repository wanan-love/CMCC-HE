'use client'

import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useStats, useSyncRuns } from './api'
import { updateUrlParam } from '@/lib/url-store'
import {
  RefreshCw,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  ChevronDown,
  Github,
  ArrowRight,
} from 'lucide-react'
import {
  formatRelativeTime,
  formatDateTimeCN,
  formatTimeShort,
  isDataFresh,
  hoursUntilNextUpdate,
} from '@/lib/relative-time'
import type { SyncRun } from './types'

const SOURCE_BADGES: Record<string, { label: string; cls: string }> = {
  scraper: { label: '定时抓取', cls: 'bg-teal-50 text-teal-700 border-teal-200' },
  'seed-import': { label: '初始导入', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  manual: { label: '手动调试', cls: 'bg-stone-50 text-stone-600 border-stone-200' },
}

/**
 * 页头「最后更新」指示器 + 点击弹出的更新动态。
 * 采集与展示分离后：数据更新不再是独立标签页，更新历史收纳于此轻量入口。
 */
export function UpdateHistoryPopover() {
  const [open, setOpen] = useState(false)
  const { data: stats } = useStats()
  // 打开时才拉取更新记录（React Query 缓存复用，避免常驻轮询）
  const { data, isLoading } = useSyncRuns(open)

  const lastRun = stats?.lastRun ?? null
  const lastIso = lastRun ? lastRun.finishedAt ?? lastRun.startedAt : null
  const fresh = isDataFresh(lastIso)

  /** 下钻当日时间轴：切时间轴 + ?date=YYYY-MM-DD（与月/年/搜索互斥，清空后写入） */
  const drillToDate = (date: string) => {
    setOpen(false) // 关闭 popover，焦点自然回退触发器
    updateUrlParam('tab', null) // timeline 为默认
    updateUrlParam('q', null)
    updateUrlParam('month', null)
    updateUrlParam('year', null)
    updateUrlParam('date', date)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="group flex items-center gap-1.5 text-xs text-stone-500 rounded-md px-1.5 py-1 -mr-1.5 cursor-pointer transition-colors hover:bg-stone-100 hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
          aria-label="查看数据更新动态"
          title={
            lastIso
              ? `最后更新：${formatDateTimeCN(lastIso)}\n更新方式：GitHub Actions 每日 04:00 自动抓取\n下次抓取：约 ${hoursUntilNextUpdate()} 小时后\n点击查看更新记录`
              : '数据尚未更新过\n点击查看详情'
          }
        >
          {stats ? (
            lastIso ? (
              <>
                <span
                  className={`size-1.5 rounded-full shrink-0 ${fresh ? 'bg-emerald-500' : 'bg-amber-500'}`}
                  aria-hidden
                />
                <span className="whitespace-nowrap tabular-nums">
                  <span className="hidden sm:inline">最后更新</span>
                  <span className="sm:hidden">更新</span>
                  {` ${formatRelativeTime(lastIso)}`}
                </span>
                <span className="hidden sm:inline text-stone-300 mx-0.5">|</span>
                <span className="hidden sm:inline whitespace-nowrap tabular-nums">
                  在售 {stats.lastRun!.totalAfter.toLocaleString()}
                </span>
              </>
            ) : (
              <span className="whitespace-nowrap">暂无更新记录</span>
            )
          ) : (
            <span className="whitespace-nowrap text-stone-400">加载中…</span>
          )}
          <ChevronDown
            className="size-3 shrink-0 text-stone-400 transition-transform duration-200 group-data-[state=open]:rotate-180"
            aria-hidden
          />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border-stone-200 p-0 shadow-lg"
      >
        {/* 标题 + 新鲜度徽章 */}
        <div className="px-3.5 py-2.5 border-b border-stone-100 flex items-center gap-2 bg-stone-50/60 rounded-t-xl">
          <RefreshCw className="size-3.5 text-emerald-600 shrink-0" />
          <span className="text-xs font-semibold text-stone-700">数据更新动态</span>
          <Badge
            variant="outline"
            className={`ml-auto text-[10px] shrink-0 ${
              lastIso
                ? fresh
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : 'bg-amber-50 text-amber-700 border-amber-200'
                : 'bg-stone-50 text-stone-500 border-stone-200'
            }`}
          >
            {lastIso ? (fresh ? '数据新鲜' : '可能延迟') : '暂无更新'}
          </Badge>
        </div>

        {/* 三指标 */}
        <div className="grid grid-cols-3 divide-x divide-stone-100 border-b border-stone-100">
          <div className="px-2.5 py-2" title={lastIso ? `最后更新：${formatDateTimeCN(lastIso)}` : '暂无更新记录'}>
            <div className="flex items-center gap-1 text-[10px] text-stone-400 mb-0.5">
              <span
                className={`size-1.5 rounded-full ${fresh ? 'bg-emerald-500' : 'bg-amber-500'}`}
                aria-hidden
              />
              最后更新
            </div>
            <div className="text-xs font-semibold text-stone-800 tabular-nums truncate">
              {lastIso ? formatRelativeTime(lastIso) : '—'}
            </div>
          </div>
          <div className="px-2.5 py-2">
            <div className="flex items-center gap-1 text-[10px] text-stone-400 mb-0.5">
              <Clock className="size-3" />
              下次抓取
            </div>
            <div className="text-xs font-semibold text-stone-800 tabular-nums truncate">
              约 {hoursUntilNextUpdate()} 小时后
            </div>
          </div>
          <div className="px-2.5 py-2">
            <div className="flex items-center gap-1 text-[10px] text-stone-400 mb-0.5">
              <Github className="size-3" />
              更新节奏
            </div>
            <div className="text-xs font-semibold text-stone-800 truncate">每日 04:00</div>
          </div>
        </div>

        {/* 更新记录列表（滚动区；成功运行行可点击下钻当日时间轴） */}
        <div className="flex items-center gap-1.5 px-3.5 pt-2.5 pb-1 text-[11px] font-medium text-stone-400">
          <Clock className="size-3" />
          更新记录
          <span className="ml-auto text-[10px] font-normal">最近 {data?.runs?.length ?? 0} 次</span>
        </div>
        <div className="max-h-64 overflow-y-auto">
          {isLoading ? (
            <div className="px-3.5 pb-3 space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-9 rounded-md" />
              ))}
            </div>
          ) : data && data.runs.length > 0 ? (
            <div className="divide-y divide-stone-50">
              {data.runs.map((r) => (
                <RunRow key={r.id} run={r} onDrill={drillToDate} />
              ))}
            </div>
          ) : (
            <div className="py-8 text-center text-xs text-stone-400">暂无更新记录</div>
          )}
        </div>

        {/* 底部说明 */}
        <div className="px-3.5 py-2 border-t border-stone-100 rounded-b-xl bg-stone-50/60 flex items-center gap-1.5 text-[10px] text-stone-400">
          <Github className="size-3 shrink-0" />
          <span className="truncate">GitHub Actions 每日 04:00 自动抓取 · 采集与展示分离，页面无手动同步</span>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function RunRow({ run, onDrill }: { run: SyncRun; onDrill: (date: string) => void }) {
  const badge = SOURCE_BADGES[run.source] ?? SOURCE_BADGES.manual
  const canDrill = run.status === 'SUCCESS' && run.added + run.removed + run.updated > 0
  return (
    <div
      className={`px-3.5 py-2.5 group/row ${
        canDrill
          ? 'cursor-pointer transition-colors hover:bg-emerald-50/60 border-l-2 border-l-transparent hover:border-l-emerald-400'
          : ''
      }`}
      onClick={canDrill ? () => onDrill(run.date) : undefined}
      title={canDrill ? `查看 ${run.date} 当日时间轴（上线/下线/变更详情）` : undefined}
    >
      <div className="flex items-center gap-2">
        {run.status === 'SUCCESS' ? (
          <CheckCircle2 className="size-3.5 text-emerald-600 shrink-0" aria-label="成功" />
        ) : run.status === 'FAILED' ? (
          <XCircle className="size-3.5 text-rose-600 shrink-0" aria-label="失败" />
        ) : (
          <Loader2 className="size-3.5 text-amber-500 animate-spin shrink-0" aria-label="进行中" />
        )}
        <span
          className={`text-xs font-medium tabular-nums ${run.status === 'FAILED' ? 'text-rose-500' : 'text-stone-700'}`}
          title={`开始于 ${formatDateTimeCN(run.startedAt)}`}
        >
          {run.date}
          <span className="text-stone-400 text-[10px] ml-1">{formatTimeShort(run.startedAt)}</span>
        </span>
        <Badge variant="outline" className={`ml-auto text-[10px] shrink-0 ${badge.cls}`}>
          {badge.label}
        </Badge>
        {canDrill && (
          <ArrowRight className="size-3 text-stone-300 shrink-0 transition-all group-hover/row:text-emerald-500 group-hover/row:translate-x-0.5" aria-hidden />
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 text-[10px] tabular-nums">
        <span className="text-emerald-600">+{run.added} 上线</span>
        <span className="text-rose-500">-{run.removed} 下线</span>
        <span className="text-amber-600">~{run.updated} 变更</span>
        <span className="ml-auto text-stone-400">在售 {run.totalAfter.toLocaleString()}</span>
      </div>
      {run.message && (
        <div className="mt-0.5 text-[10px] text-stone-400 truncate" title={run.message}>
          {run.message}
        </div>
      )}
    </div>
  )
}
