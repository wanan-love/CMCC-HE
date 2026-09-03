'use client'

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { Share2, Sparkles, Crosshair, GitCompare, Check } from 'lucide-react'
import { useTariffDetail } from './api'
import {
  CATEGORY_COLORS,
  TYPE_META,
  SOURCE_LABELS,
  formatDateCN,
  daysUntil,
  type UsageItem,
  type ChangeEventItem,
  type SimilarTariff,
} from './types'

interface ChangedField {
  field: string
  before: string | null
  after: string | null
}

export function TariffDetailDialog({
  code,
  onOpenChange,
  onSelectTariff,
  onShowInTimeline,
  compareCodes,
  onToggleCompare,
}: {
  code: string | null
  onOpenChange: (open: boolean) => void
  onSelectTariff?: (code: string) => void
  /** 在时间轴中仅看此资费的完整轨迹 */
  onShowInTimeline?: (code: string) => void
  /** 已加入对比的资费编码（相似推荐卡展示加入状态） */
  compareCodes?: string[]
  /** 相似推荐卡「加入对比」快捷入口（复用 page 层勾选逻辑，含上限 toast） */
  onToggleCompare?: (code: string) => void
}) {
  const { data, isLoading } = useTariffDetail(code)

  const tariff = data?.tariff
  let usage: UsageItem[] = []
  let extra: Record<string, string> = {}
  try {
    usage = tariff ? JSON.parse(tariff.usageJson || '[]') : []
    extra = tariff ? JSON.parse(tariff.extraJson || '{}') : {}
  } catch {
    /* ignore */
  }

  const offlineCountdown = daysUntil(tariff?.offlineDate ?? null)

  const shareLink = async () => {
    const url = new URL(window.location.href)
    url.searchParams.set('tariff', code || '')
    try {
      await navigator.clipboard.writeText(url.toString())
      toast.success('链接已复制：任何打开该链接的人都会看到这个资费详情')
    } catch {
      toast.info(`分享链接：${url.toString()}`)
    }
  }

  return (
    <Dialog open={!!code} onOpenChange={(o) => onOpenChange(o)}>
      <DialogContent className="max-w-2xl max-h-[85vh] p-0 gap-0">
        <ScrollArea className="max-h-[85vh]">
          <div className="p-6">
            <DialogHeader className="text-left space-y-2 pb-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={CATEGORY_COLORS[tariff?.category ?? ''] ?? CATEGORY_COLORS['其他']}>
                  {tariff?.category ?? '…'}
                </Badge>
                {tariff?.scope && (
                  <Badge variant="outline" className="bg-stone-50 text-stone-600 border-stone-200">
                    {tariff.scope} · {tariff.range}
                  </Badge>
                )}
                {tariff?.status === 'OFFLINE' ? (
                  <Badge className="bg-rose-100 text-rose-700 border border-rose-200 hover:bg-rose-100">
                    已下线
                  </Badge>
                ) : (
                  offlineCountdown !== null && (
                    <Badge
                      className={
                        offlineCountdown <= 30
                          ? 'bg-rose-100 text-rose-700 border border-rose-200 hover:bg-rose-100'
                          : 'bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-50'
                      }
                      variant="outline"
                    >
                      距下线 {offlineCountdown} 天
                    </Badge>
                  )
                )}
                <div className="flex-1" />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1 border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                  onClick={shareLink}
                >
                  <Share2 className="size-3.5" />
                  分享链接
                </Button>
              </div>
              <DialogTitle className="text-xl leading-snug">
                {tariff?.name ?? (isLoading ? '加载中…' : '未知资费')}
              </DialogTitle>
              <DialogDescription>
                方案编号 {tariff?.code ?? '—'} · {formatDateCN(tariff?.onlineDate ?? null)} 上线
                {tariff?.offlineDate ? ` · ${formatDateCN(tariff.offlineDate)} 下线` : ''}
              </DialogDescription>
            </DialogHeader>

            {isLoading && (
              <div className="space-y-3 pt-4">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            )}

            {tariff && (
              <>
                {/* 价格卡片 */}
                <div className="mt-4 rounded-xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-teal-50 p-4">
                  <div className="text-xs text-emerald-700/70 font-medium">资费标准</div>
                  <div className="text-2xl font-bold text-emerald-800 mt-1">
                    {tariff.price || '未公示'}
                  </div>
                </div>

                {/* 基本字段 */}
                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                  <Field label="适用范围" value={tariff.target} />
                  <Field label="销售渠道" value={tariff.channels} />
                  <Field label="有效期限" value={tariff.effective} />
                  <Field label="在网要求" value={tariff.requirement} />
                  <Field label="退订方式" value={tariff.unsubscribe} />
                  <Field label="违约责任" value={tariff.liability} />
                </div>

                {/* 套餐内容 */}
                {usage.length > 0 && (
                  <>
                    <Separator className="my-5" />
                    <h4 className="text-sm font-semibold text-stone-700 mb-3">套餐内容</h4>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {usage.map((u, i) => (
                        <div
                          key={i}
                          className="rounded-lg border border-stone-200 bg-white p-3 text-center"
                        >
                          <div className="text-[11px] text-stone-500">{u.label}</div>
                          <div className="text-sm font-semibold text-stone-800 mt-1 break-all">
                            {u.value}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {/* 其他说明 */}
                {Object.keys(extra).length > 0 && (
                  <>
                    <Separator className="my-5" />
                    <h4 className="text-sm font-semibold text-stone-700 mb-3">资费说明</h4>
                    <div className="space-y-3">
                      {Object.entries(extra).map(([k, v]) =>
                        v ? (
                          <div key={k} className="text-sm rounded-lg bg-stone-50 border border-stone-100 p-3">
                            <span className="font-medium text-stone-600">{k}：</span>
                            <span className="text-stone-600 whitespace-pre-wrap">{v}</span>
                          </div>
                        ) : null
                      )}
                    </div>
                  </>
                )}

                {/* 变更历史 */}
                {data && data.events.length > 0 && (
                  <>
                    <Separator className="my-5" />
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                      <h4 className="text-sm font-semibold text-stone-700">
                        变更历史（{data.events.length}）
                      </h4>
                      {code && onShowInTimeline && (
                        <button
                          onClick={() => onShowInTimeline(code)}
                          className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md border border-teal-300 bg-teal-50 text-teal-700 text-xs font-medium hover:bg-teal-100 transition-colors"
                          title="关闭弹窗并在时间轴中仅查看该资费的全部事件"
                        >
                          <Crosshair className="size-3.5" />
                          在时间轴仅看此资费
                        </button>
                      )}
                    </div>
                    <div className="space-y-2 max-h-64 overflow-y-auto pr-2">
                      {data.events.map((e: ChangeEventItem) => (
                        <EventHistoryItem key={e.id} event={e} />
                      ))}
                    </div>
                  </>
                )}

                {/* 相似资费推荐 */}
                {data && data.similar.length > 0 && (
                  <>
                    <Separator className="my-5" />
                    <h4 className="text-sm font-semibold text-stone-700 mb-1 flex items-center gap-1.5">
                      <Sparkles className="size-3.5 text-emerald-600" />
                      相似资费推荐
                      <span className="text-xs font-normal text-stone-400">
                        同分类 · 在售 · 综合匹配（价格/人群/渠道）· 可直接加入对比
                      </span>
                    </h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {data.similar.map((t) => (
                        <SimilarTariffCard
                          key={t.code}
                          tariff={t}
                          basePrice={tariff.priceValue}
                          onClick={() => onSelectTariff?.(t.code)}
                          inCompare={!!compareCodes?.includes(t.code)}
                          onToggleCompare={
                            onToggleCompare ? () => onToggleCompare(t.code) : undefined
                          }
                        />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex gap-2 items-baseline">
      <span className="text-stone-400 text-xs shrink-0">{label}</span>
      <span className="text-stone-700">{value || '—'}</span>
    </div>
  )
}

/** 相似资费卡片：价格差标记 + 点击切换详情 + 「加入对比」快捷入口
    外层用 div[role=button]（内层嵌真实按钮，合法 HTML 且键盘可达） */
function SimilarTariffCard({
  tariff,
  basePrice,
  onClick,
  inCompare,
  onToggleCompare,
}: {
  tariff: SimilarTariff
  basePrice: number | null
  onClick: () => void
  /** 该相似资费是否已在对比清单中 */
  inCompare: boolean
  /** 加入/移出对比（由 page 层统一处理上限） */
  onToggleCompare?: () => void
}) {
  const diff =
    basePrice !== null && tariff.priceValue !== null
      ? tariff.priceValue - basePrice
      : null
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`查看 ${tariff.name} 详情`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className="group text-left rounded-lg border bg-white p-2.5 transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 hover:border-emerald-300 hover:shadow-sm ${
        inCompare ? 'border-emerald-300 bg-emerald-50/30' : 'border-stone-200'
      }"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-stone-800 truncate flex-1 group-hover:text-emerald-700 transition-colors">
          {tariff.name}
        </span>
        {diff !== null && diff !== 0 && (
          <span
            className={`text-[10px] font-semibold shrink-0 px-1 rounded ${
              diff > 0 ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-600'
            }`}
          >
            {diff > 0 ? '+' : ''}
            {diff}元
          </span>
        )}
        {diff === 0 && (
          <span className="text-[10px] bg-stone-100 text-stone-500 shrink-0 px-1 rounded">同价</span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2 text-[10px] text-stone-400">
        <span className="text-emerald-700 font-medium">{tariff.price || '未公示'}</span>
        <span>·</span>
        <span className="truncate">{tariff.target || '—'}</span>
        {/* 加入对比快捷入口（点击不切换详情） */}
        {onToggleCompare && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onToggleCompare()
            }}
            title={inCompare ? '已在对比清单，点击移出' : '加入资费对比（最多 3 个）'}
            aria-label={inCompare ? `移出对比 ${tariff.name}` : `加入对比 ${tariff.name}`}
            className={`ml-auto shrink-0 inline-flex items-center gap-1 h-5 px-1.5 rounded-md border text-[10px] font-medium transition-all active:scale-95 ${
              inCompare
                ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
                : 'bg-white text-stone-400 border-stone-200 opacity-0 group-hover:opacity-100 hover:border-emerald-300 hover:text-emerald-700 focus-visible:opacity-100'
            }`}
          >
            {inCompare ? (
              <>
                <Check className="size-2.5" />
                已加入
              </>
            ) : (
              <>
                <GitCompare className="size-2.5" />
                对比
              </>
            )}
          </button>
        )}
      </div>
      {tariff.matchTags && tariff.matchTags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {tariff.matchTags.map((tag) => (
            <span
              key={tag}
              className="text-[9px] px-1.5 py-0.5 rounded bg-teal-50 text-teal-700 border border-teal-100"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function EventHistoryItem({ event }: { event: ChangeEventItem }) {
  const meta = TYPE_META[event.type]
  let changes: ChangedField[] = []
  try {
    changes = event.changedFields ? JSON.parse(event.changedFields) : []
  } catch {
    /* ignore */
  }
  return (
    <div className={`rounded-lg border p-3 text-sm ${meta?.bg ?? 'bg-stone-50 border-stone-200'}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-bold ${meta?.color}`}>
            {meta?.icon} {meta?.label}
          </span>
          <span className="text-xs text-stone-500">{formatDateCN(event.date)}</span>
        </div>
        <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
          {SOURCE_LABELS[event.source] ?? event.source}
        </Badge>
      </div>
      {changes.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {changes.map((c, i) => (
            <div key={i} className="text-xs bg-white/70 rounded px-2 py-1.5 border border-white">
              <span className="font-medium text-stone-600">{c.field}：</span>
              <span className="text-rose-600 line-through mr-1">{c.before || '无'}</span>
              <span className="text-stone-400">→</span>
              <span className="text-emerald-700 ml-1 font-medium">{c.after || '无'}</span>
            </div>
          ))}
        </div>
      )}
      {event.summary && <div className="text-xs text-stone-600 mt-1">{event.summary}</div>}
    </div>
  )
}
