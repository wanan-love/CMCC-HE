/**
 * URL 地址栏作为外部状态系统的统一封装
 * （useSyncExternalStore 模式：天然处理 SSR 水合差异与浏览器前进/后退）
 */

const urlListeners = new Set<() => void>()

export function subscribeUrl(cb: () => void) {
  urlListeners.add(cb)
  const onPop = () => cb()
  window.addEventListener('popstate', onPop)
  return () => {
    urlListeners.delete(cb)
    window.removeEventListener('popstate', onPop)
  }
}

/** 更新 URL 参数并通知所有订阅者（外部系统 = 浏览器地址栏） */
export function updateUrlParam(param: string, value: string | null) {
  const url = new URL(window.location.href)
  if (value) url.searchParams.set(param, value)
  else url.searchParams.delete(param)
  window.history.replaceState(null, '', url.toString())
  urlListeners.forEach((l) => l())
}

export function readUrlParam(param: string): string {
  return new URLSearchParams(window.location.search).get(param) ?? ''
}

/** 服务端快照（SSR 时无 window）：参数一律回退空值 */
export function getServerParamSnapshot(): string {
  return ''
}

/** 从 URL ?month= 读取月份下钻 YYYY-MM（外部快照；时间轴与洞察页共用） */
export function getMonthFromUrl(): string {
  return readUrlParam('month')
}

/** 从 URL ?year= 读取年度下钻 YYYY（外部快照；时间轴与洞察页共用） */
export function getYearFromUrl(): string {
  return readUrlParam('year')
}

/** 从 URL ?date= 读取日期下钻 YYYY-MM-DD（外部快照；时间轴/页头更新记录下钻共用） */
export function getDateFromUrl(): string {
  return readUrlParam('date')
}
