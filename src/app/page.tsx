'use client'

import { useState, useCallback, useEffect, useSyncExternalStore } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/hooks/use-toast'
import {
  Radar,
  TrendingUp,
  TrendingDown,
  Database,
  Timer,
  BarChart3,
  GitCompare,
  Package,
  AlertTriangle,
  X,
} from 'lucide-react'
import { useStats } from '@/components/tariff/api'
import { TimelineTab } from '@/components/tariff/TimelineTab'
import { LibraryTab, CompareBar } from '@/components/tariff/LibraryTab'
import { UpcomingTab } from '@/components/tariff/UpcomingTab'
import { InsightsTab } from '@/components/tariff/InsightsTab'
import { UpdateHistoryPopover } from '@/components/tariff/UpdateHistoryPopover'
import { TariffDetailDialog } from '@/components/tariff/TariffDetailDialog'
import { CompareDialog } from '@/components/tariff/CompareDialog'
import { subscribeUrl, updateUrlParam, readUrlParam, getServerParamSnapshot } from '@/lib/url-store'
import { isDataStale, staleHours, hoursUntilNextUpdate } from '@/lib/relative-time'

const TARIFF_PARAM = 'tariff'
const TAB_PARAM = 'tab'
const QUERY_PARAM = 'q'
const MONTH_PARAM = 'month'
const YEAR_PARAM = 'year'
const DATE_PARAM = 'date'
const PRICEBAND_PARAM = 'band'
const CATEGORY_PARAM = 'category'
const MAX_COMPARE = 3
const VALID_TABS = ['timeline', 'library', 'upcoming', 'insights']

/* ============ URL 作为资费详情的单一数据源（订阅/更新统一走 @/lib/url-store） ============ */

function getTariffFromUrl(): string | null {
  const v = readUrlParam(TARIFF_PARAM)
  return v || null
}

/** 服务端快照（SSR 时无 window） */
function getServerSnapshot(): string | null {
  return null
}

/** 更新 URL 中的资费参数并通知订阅者 */
function setTariffParam(code: string | null) {
  updateUrlParam(TARIFF_PARAM, code)
}

/** 从 URL ?tab= 读取当前 tab（外部快照） */
function getTabFromUrl(): string {
  const t = readUrlParam(TAB_PARAM)
  return t && VALID_TABS.includes(t) ? t : 'timeline'
}

/** 服务端快照（SSR 时无 window） */
function getServerTabSnapshot(): string {
  return 'timeline'
}

/** 从 URL ?q= 读取时间轴深链接搜索词（外部快照） */
function getQueryFromUrl(): string {
  return readUrlParam(QUERY_PARAM)
}

/** 从 URL ?band= 读取资费库价格带深链接（外部快照） */
function getBandFromUrl(): string {
  return readUrlParam(PRICEBAND_PARAM)
}

/** 从 URL ?category= 读取资费库分类深链接（外部快照） */
function getCategoryFromUrl(): string {
  return readUrlParam(CATEGORY_PARAM)
}

export default function Home() {
  // URL ?tab= → 当前视图（useSyncExternalStore 读外部 URL 状态，RSS 条目/外部链接直达）
  const tab = useSyncExternalStore(subscribeUrl, getTabFromUrl, getServerTabSnapshot)
  // URL ?tariff= → 详情弹窗（useSyncExternalStore 天然处理 SSR/水合差异）
  const selectedCode = useSyncExternalStore(subscribeUrl, getTariffFromUrl, getServerSnapshot)
  const [compareCodes, setCompareCodes] = useState<string[]>([])
  const [compareOpen, setCompareOpen] = useState(false)
  const { data: stats, isLoading } = useStats()
  const { toast } = useToast()
  // URL ?q= → 时间轴深链接搜索（详情弹窗"仅看此资费"入口写 入）
  const deepQuery = useSyncExternalStore(subscribeUrl, getQueryFromUrl, getServerParamSnapshot)

  // 选择资费（打开详情 + 同步 URL，可分享）
  const selectTariff = useCallback((code: string) => {
    setTariffParam(code)
  }, [])

  // 关闭详情弹窗
  const closeDetail = useCallback(() => {
    setTariffParam(null)
  }, [])

  // 在时间轴中查看某资费的完整变更轨迹：关弹窗 + 切时间轴 + q=code 过滤（清月/年/日下钻）
  const showInTimeline = useCallback((code: string) => {
    updateUrlParam(TARIFF_PARAM, null)
    updateUrlParam(TAB_PARAM, null) // timeline 为默认，同时清除其他 tab 参数
    updateUrlParam(QUERY_PARAM, code)
    updateUrlParam(MONTH_PARAM, null)
    updateUrlParam(YEAR_PARAM, null)
    updateUrlParam(DATE_PARAM, null)
  }, [])

  // 清除深链接搜索（用户点击过滤 badge 的 ✕）
  const clearDeepQuery = useCallback(() => {
    updateUrlParam(QUERY_PARAM, null)
  }, [])

  // 清除月份下钻（TimelineTab 内部通过 URL store 自管，无需 page 层回调）
  // URL ?band= → 资费库价格带深链接（洞察 KPI 卡点击写入）
  const deepPriceBand = useSyncExternalStore(subscribeUrl, getBandFromUrl, getServerParamSnapshot)

  const clearDeepPriceBand = useCallback(() => {
    updateUrlParam(PRICEBAND_PARAM, null)
  }, [])

  // 洞察图月份下钻：切时间轴 + ?month=YYYY-MM 过滤（可分享；与日期/年度互斥：月份优先）
  const drillToMonth = useCallback((month: string) => {
    updateUrlParam(TAB_PARAM, null) // timeline 为默认
    updateUrlParam(QUERY_PARAM, null)
    updateUrlParam(MONTH_PARAM, month)
    updateUrlParam(YEAR_PARAM, null) // 月份与年度互斥：月份优先
    updateUrlParam(DATE_PARAM, null) // 月份与日期互斥：月份优先
  }, [])

  // 洞察年度图下钻：切时间轴 + ?year=YYYY 过滤（可分享；与月份/日期互斥）
  const drillToYear = useCallback((year: string) => {
    updateUrlParam(TAB_PARAM, null) // timeline 为默认
    updateUrlParam(QUERY_PARAM, null)
    updateUrlParam(MONTH_PARAM, null)
    updateUrlParam(YEAR_PARAM, year)
    updateUrlParam(DATE_PARAM, null) // 年度与日期互斥
  }, [])

  // 洞察 KPI 卡下钻：切资费库 + ?band= 价格带预筛选（free/≤29/…）
  const drillToPriceBand = useCallback((band: string) => {
    updateUrlParam(TAB_PARAM, 'library')
    updateUrlParam(QUERY_PARAM, null)
    updateUrlParam(MONTH_PARAM, null)
    updateUrlParam(PRICEBAND_PARAM, band)
  }, [])

  // 洞察分类占比饼图下钻：切资费库 + ?category= 分类预筛选（与 band 同模式）
  const drillToCategory = useCallback((category: string) => {
    updateUrlParam(TAB_PARAM, 'library')
    updateUrlParam(QUERY_PARAM, null)
    updateUrlParam(MONTH_PARAM, null)
    updateUrlParam(PRICEBAND_PARAM, null)
    updateUrlParam(CATEGORY_PARAM, category)
  }, [])

  // URL ?category= → 资费库分类深链接（洞察饼图扇区点击写入）
  const deepCategory = useSyncExternalStore(subscribeUrl, getCategoryFromUrl, getServerParamSnapshot)

  const clearDeepCategory = useCallback(() => {
    updateUrlParam(CATEGORY_PARAM, null)
  }, [])

  // 对比勾选
  const toggleCompare = useCallback(
    (code: string) => {
      setCompareCodes((prev) => {
        if (prev.includes(code)) return prev.filter((c) => c !== code)
        if (prev.length >= MAX_COMPARE) {
          toast({ title: '最多对比 3 个', description: '请先移除已选资费', variant: 'destructive' })
          return prev
        }
        return [...prev, code]
      })
    },
    [toast]
  )

  // 切换 tab 时同步 URL ?tab=（可分享/可后退）
  const switchTab = useCallback((v: string) => {
    updateUrlParam(TAB_PARAM, v === 'timeline' ? null : v)
  }, [])

  // 清理失效的 ?tab= 深链接（如已下线的 sync tab）——回退 timeline 并同步 URL
  // 持续订阅地址栏变化：初始化与浏览器前进/后退（popstate）到达失效链接时均会清理
  useEffect(() => {
    const clean = () => {
      const t = readUrlParam(TAB_PARAM)
      if (t && !VALID_TABS.includes(t)) updateUrlParam(TAB_PARAM, null)
    }
    clean()
    return subscribeUrl(clean)
  }, [])

  // 数据过期警示（>48h 未更新；可手动关闭，stats 60s 轮询自动重估）
  const [staleDismissed, setStaleDismissed] = useState(false)
  const lastUpdateIso = stats?.lastRun ? stats.lastRun.finishedAt ?? stats.lastRun.startedAt : null
  const dataStale = isDataStale(lastUpdateIso)
  const staleBanner =
    dataStale && !staleDismissed ? (
      <div role="alert" className="w-full bg-amber-50/95 border-b border-amber-200">
        <div className="max-w-6xl mx-auto px-4 py-2 flex items-center gap-2.5 text-xs text-amber-800">
          <AlertTriangle className="size-4 text-amber-500 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="font-semibold">数据已 {staleHours(lastUpdateIso)} 小时未更新</span>
            <span className="text-amber-700 hidden sm:inline">
              ，可能原因：公示页改版 / 抓取任务失败。可点击右上角「最后更新」查看更新记录与失败原因。
            </span>
            <span className="text-amber-700 sm:hidden">· 点右上角「最后更新」查看详情</span>
          </span>
          <button
            type="button"
            onClick={() => setStaleDismissed(true)}
            className="shrink-0 p-1 rounded-md hover:bg-amber-100 transition-colors cursor-pointer"
            aria-label="关闭警示"
            title="关闭（数据恢复新鲜后自动消失）"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
    ) : null

  return (
    <div className="min-h-screen flex flex-col bg-stone-50/80">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-stone-200/80 bg-white/90 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="size-9 rounded-xl bg-gradient-to-br from-emerald-600 to-teal-600 flex items-center justify-center shadow-sm shrink-0">
            <Radar className="size-5 text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-bold text-stone-900 leading-tight truncate">
              河北移动资费观察
            </h1>
            <p className="text-[11px] text-stone-500 leading-tight truncate">
              资费公示每日对比 · 上线 / 下线时间轴
            </p>
          </div>
          <div className="flex-1" />
          {/* 最后更新指示器（可点击查看更新动态：采集与展示分离，每日 04:00 自动抓取，页面无手动同步） */}
          <div className="shrink-0">
            <UpdateHistoryPopover />
          </div>
        </div>
      </header>

      {/* 数据过期警示条（>48h 未更新：页面级主动提示，可关闭；与页头黄点分级） */}
      {staleBanner}

      {/* Main */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-5 space-y-5 pb-24">
        {/* KPI 统计卡片 */}
        <section aria-label="统计概览" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {isLoading || !stats ? (
            [1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)
          ) : (
            <>
              <KpiCard
                icon={Database}
                label="在售资费总数"
                value={stats.online.toLocaleString()}
                sub={`累计收录 ${stats.total.toLocaleString()}`}
                tone="emerald"
              />
              <KpiCard
                icon={TrendingUp}
                label="今日新上线"
                value={stats.today.added.toLocaleString()}
                sub="每日 04:00 抓取对比"
                tone="emerald"
              />
              <KpiCard
                icon={TrendingDown}
                label="今日下线"
                value={stats.today.removed.toLocaleString()}
                sub={`变更 ${stats.today.updated} 条`}
                tone="rose"
              />
              <KpiCard
                icon={Timer}
                label="90天内将下线"
                value={stats.upcomingSoon.toLocaleString()}
                sub={stats.upcomingSample[0]?.offlineDate
                  ? `最早 ${stats.upcomingSample[0].offlineDate}`
                  : '暂无'}
                tone="amber"
              />
            </>
          )}
        </section>

        {/* 即将下线跑马灯提示 */}
        {stats && stats.upcomingSample.length > 0 && (
          <Card className="border-amber-200 bg-gradient-to-r from-amber-50/80 to-orange-50/60 shadow-sm">
            <CardContent className="p-3 flex items-center gap-3 overflow-hidden">
              <Badge variant="outline" className="bg-amber-100 text-amber-800 border-amber-300 shrink-0">
                <Timer className="size-3 mr-1" />下线预告
              </Badge>
              <div className="flex-1 min-w-0 text-xs text-amber-800 truncate">
                {stats.upcomingSample
                  .slice(0, 3)
                  .map((t) => `${t.name}（${t.offlineDate}）`)
                  .join('　·　')}
                {stats.upcomingSoon > 3 && ` 等 ${stats.upcomingSoon} 个资费即将下线`}
              </div>
            </CardContent>
          </Card>
        )}

        {/* 主体 Tabs（4 视团单行；数据更新已收纳至页头 popover） */}
        <Tabs value={tab} onValueChange={switchTab}>
          <TabsList className="grid w-full grid-cols-4 h-auto p-1 bg-white border border-stone-200 shadow-sm">
            <TabsTrigger value="timeline" className="px-1 sm:px-2 text-[11px] sm:text-sm py-2 gap-1 sm:gap-1.5 data-[state=active]:bg-emerald-50 data-[state=active]:text-emerald-700">
              <GitCompare className="size-3.5 shrink-0" />时间轴
            </TabsTrigger>
            <TabsTrigger value="library" className="px-1 sm:px-2 text-[11px] sm:text-sm py-2 gap-1 sm:gap-1.5 data-[state=active]:bg-emerald-50 data-[state=active]:text-emerald-700">
              <Package className="size-3.5 shrink-0" />资费库
            </TabsTrigger>
            <TabsTrigger value="upcoming" className="px-1 sm:px-2 text-[11px] sm:text-sm py-2 gap-1 sm:gap-1.5 data-[state=active]:bg-emerald-50 data-[state=active]:text-emerald-700">
              <Timer className="size-3.5 shrink-0" />下线预告
            </TabsTrigger>
            <TabsTrigger value="insights" className="px-1 sm:px-2 text-[11px] sm:text-sm py-2 gap-1 sm:gap-1.5 data-[state=active]:bg-emerald-50 data-[state=active]:text-emerald-700">
              <BarChart3 className="size-3.5 shrink-0" />数据洞察
            </TabsTrigger>
          </TabsList>

          <TabsContent value="timeline" className="mt-4">
            {/* key 仅绑定 ?q= 深链接（重挂载预填搜索）；?month= 由 TimelineTab 内部用 URL store 自管（避免清月份时误重挂丢失日期过滤） */}
            <TimelineTab
              key={`tl-${deepQuery}`}
              initialQuery={deepQuery}
              onClearInitialQuery={clearDeepQuery}
              onSelectTariff={selectTariff}
            />
          </TabsContent>
          <TabsContent value="library" className="mt-4">
            {/* key 绑定 ?band=/?category= 深链接（洞察价格卡/饼图下钻预筛选） */}
            <LibraryTab
              key={`lib-${deepPriceBand}-${deepCategory}`}
              initialPriceBand={deepPriceBand}
              onClearInitialPriceBand={clearDeepPriceBand}
              initialCategory={deepCategory}
              onClearInitialCategory={clearDeepCategory}
              onSelectTariff={selectTariff}
              compareCodes={compareCodes}
              onToggleCompare={toggleCompare}
              onClearCompare={() => setCompareCodes([])}
            />
          </TabsContent>
          <TabsContent value="upcoming" className="mt-4">
            <UpcomingTab onSelectTariff={selectTariff} />
          </TabsContent>
          <TabsContent value="insights" className="mt-4">
            <InsightsTab
              onDrillToMonth={drillToMonth}
              onDrillToPriceBand={drillToPriceBand}
              onDrillToCategory={drillToCategory}
              onDrillToYear={drillToYear}
            />
          </TabsContent>
        </Tabs>
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-stone-200 bg-white/80 backdrop-blur-sm pb-[env(safe-area-inset-bottom)]">
        <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-stone-400">
          <span>数据来源：中国移动资费公示专区（h.app.coc.10086.cn）· 河北省个人/政企资费</span>
          <span className="text-stone-200">|</span>
          <span>本站仅为公开信息聚合展示，资费详情以官方公示为准</span>
          <span className="text-stone-200">|</span>
          <span>
            收录 {stats?.total ?? 0} 条 · 事件 {stats?.eventSources?.reduce((a, s) => a + s._count._all, 0) ?? 0} 条
          </span>
        </div>
      </footer>

      {/* 资费详情弹窗（URL ?tariff=CODE 可分享，相似推荐可切换/可加入对比，可跳时间轴仅看此资费） */}
      <TariffDetailDialog
        code={selectedCode}
        onOpenChange={(o) => !o && closeDetail()}
        onSelectTariff={selectTariff}
        onShowInTimeline={showInTimeline}
        compareCodes={compareCodes}
        onToggleCompare={toggleCompare}
      />

      {/* 资费对比 */}
      {compareOpen && (
        <CompareDialog
          codes={compareCodes}
          onOpenChange={(o) => {
            if (!o) setCompareOpen(false)
          }}
          onSelectTariff={(code) => {
            setCompareOpen(false)
            selectTariff(code)
          }}
        />
      )}
      {!compareOpen && (
        <CompareBar
          codes={compareCodes}
          onClear={() => setCompareCodes([])}
          onCompare={() => setCompareOpen(true)}
          onRemove={(code) => setCompareCodes((prev) => prev.filter((c) => c !== code))}
        />
      )}
    </div>
  )
}

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: typeof Database
  label: string
  value: string
  sub: string
  tone: 'emerald' | 'rose' | 'amber'
}) {
  const tones = {
    emerald: 'border-emerald-200 bg-gradient-to-br from-emerald-50/90 to-teal-50/50 text-emerald-900',
    rose: 'border-rose-200 bg-gradient-to-br from-rose-50/90 to-orange-50/50 text-rose-900',
    amber: 'border-amber-200 bg-gradient-to-br from-amber-50/90 to-yellow-50/50 text-amber-900',
  }
  const iconTones = {
    emerald: 'bg-emerald-100 text-emerald-600',
    rose: 'bg-rose-100 text-rose-600',
    amber: 'bg-amber-100 text-amber-600',
  }
  return (
    <Card
      className={`${tones[tone]} border shadow-sm transition-all duration-200
        hover:shadow-md hover:-translate-y-0.5 active:translate-y-0
        ${tone === 'emerald' ? 'hover:border-emerald-300' : tone === 'rose' ? 'hover:border-rose-300' : 'hover:border-amber-300'}`}
    >
      <CardContent className="p-3.5 sm:p-4">
        <div className="flex items-center gap-2.5">
          <div className={`size-8 rounded-lg flex items-center justify-center shrink-0 ${iconTones[tone]} transition-transform duration-200 group-hover:scale-110`}>
            <Icon className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] opacity-70 truncate">{label}</div>
            <div className="text-xl font-bold leading-tight tabular-nums tracking-tight">{value}</div>
          </div>
        </div>
        <div className="text-[10px] opacity-60 mt-1.5 truncate">{sub}</div>
      </CardContent>
    </Card>
  )
}
