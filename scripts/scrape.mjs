/**
 * 中国移动河北资费公示抓取 —— GitHub Actions / 本地通用版（Playwright）
 * 运行: node scripts/scrape.mjs   （需先: npm i playwright && npx playwright install --with-deps chromium）
 * 冒烟: SCRAPE_SMOKE=1 node scripts/scrape.mjs  （验证导航+选择器+类型枚举+捕获通道健康，不落盘）
 * 离线回归: node scripts/mock-site.mjs 后 SCRAPE_URL=http://localhost:3939/tariff.html node scripts/scrape.mjs
 *
 * 采集范围：仅「个人资费 · 河北省专属」，但覆盖【全部资费类型】——
 *   套餐 / 加装包 / 营销活动 / 港澳台(国际)资费 / 标准资费（以及页面动态提供的
 *   国际及港澳台标准资费、其他）。类型下拉选项在运行时动态枚举，页面未来增删
 *   类型无需改本脚本。
 *
 * ── 逆向接口（2026-09-04 二次逆向修正，v4 关键发现）────────────────────────
 * 前端结构：tariffZonePers.html → Vue + webpack 动态 chunk
 *   （tariffZonePers.js 入口 + chunk-155 NavBarNew 导航/列表分页 + chunk-837
 *    tariffSerial 卡片 + chunk-929 等 StandarTariff 标准资费表格）
 * 接口（base https://h.app.coc.10086.cn，请求库为 axios/XHR）：
 *   1) 列表分页 POST /website/nrapigate/nrtariff/new/Tariff/getTariffListInfo
 *      body {province:'311', isPublic:'1', tariffAttr:'2'分省, type1:'1'个人,
 *            type2:'1'~'7', page, limit:5}
 *   2) 标准资费 POST .../getStandardlist {province, isPublic} → rspBody 为
 *      数组或 {tariffList:[...]}，每组 {tariffTable:{tHead,tBody}}——
 *      官方页面只用 tariffList[0]（首组表格），本脚本提取【全部组】
 *   3) 类型可用性 POST .../getType2List
 *   4) 类型值映射（chunk-155 硬编码）：1套餐/2加装包/3营销活动/4港澳台国际/
 *      5标准资费(特殊值，仅分省页签且数据存在时出现)6国际及港澳台标准/7其他
 *   5) 懒加载：scroll-flag 元素进入视口触发下一页（每页 5 条）
 *
 *   ★ v4 关键发现：这些接口走 isWX 加密通道——请求体经 ff() 加密后发出，
 *     响应为 {body:'<密文>'} 信封，在 axios 响应拦截器内经 F6() 解密后
 *     JSON.parse 才得到业务明文（chunk-common.js 响应拦截器实证）。
 *     ⇒ 网络层（page.on('response')）永远拿不到 page.total / beans / 表格——
 *     v3 的"接口 total=未知 ⚠ 未核对"即因此失效，齐全性闸门形同虚设。
 *   ⇒ v4 方案：addInitScript 在页面任何 JS 之前 hook 全局 JSON.parse（解密
 *     明文必经之路），并包装 XHR open/onreadystatechange 把"当前请求 URL"
 *     传递给捕获点，实现【应用层明文捕获 + 端点精确关联】：
 *     - getTariffListInfo 明文 → page.total（齐全性基准）+ beans（原始数据）
 *     - getStandardlist 明文 → 全部标准资费表格组
 *
 *   齐全性门禁（宁缺毋滥，比 v3 严格）：
 *     - 选项在下拉中存在 ⇒ 该类型必须有数据：count==0 且 apiTotal!=0（含
 *       未知）即 FAILED——2026-09-04 事故（套餐被下拉切换 bug 跳过 → 0 条
 *       照常推送 → 502 套餐全部误判下线）根因修复之一；
 *     - count>0 且 apiTotal 已知 ⇒ 必须 count >= apiTotal（自愈重滚后仍不足
 *       即 FAILED）；apiTotal 未知（捕获通道异常）⇒ 降级 ⚠ 通过但报告显式标注。
 *     任一 FAILED → 非零退出 → workflow 中止，不推送。
 *
 * 网络出口：GitHub Actions 中由 workflow 先连接 Cloudflare WARP（TUN 或 docker
 *   socks5 代理），Chromium 的全部请求自然经 WARP 出口，避免数据中心 IP 被风控。
 *   注入 WARP_SOCKS 环境变量时 Chromium 走 socks5 代理（效果等价，推送 API 走直连）。
 *
 * 真人节奏（防风控核心，处处随机不可预测）：
 *   1. 所有等待均带随机抖动 jitter(min,max)——没有两次运行的节奏相同；
 *   2. 滚动是「浏览式」而非「机器式」：每轮 1~3 小步滚动 + 轮末直跳绝对底部
 *      （懒加载触发器），步间 0.8~1.8s，轮间 2~5s，15% 概率 5~9s「阅读停留」；
 *   3. 切类型/切页签 8~16s、重试冷却 60~90s 大间隔随机；
 *   4. 视口尺寸微随机（宽 1346~1386 / 高 870~930）；
 *   5. 偶发鼠标轨迹漂移（mouseDrift），补充真实指针事件。
 *
 * 输出: seed/p_h_<类型>.json（各类型卡片数组，卡片内含 _sourceType 标记来源类型）；
 *   seed/api/api-report.json（应用层捕获的齐全性报告）
 *   seed/api/beans-<类型>.json（接口 beans 原始数据，供未来数据源直连分析）
 *   seed/api/standard-raw.json（标准资费解密明文）
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = process.env.SCRAPE_OUT_DIR || join(__dirname, '..', 'seed')
const API_DUMP_DIR = join(OUT_DIR, 'api')
const SMOKE = !!process.env.SCRAPE_SMOKE
const URL =
  process.env.SCRAPE_URL ||
  'https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html?pageId=834148205904408576&prov=531'

/** 文件名安全化（'港澳台/国际资费' → '港澳台_国际资费'） */
const fileSafe = (s) => s.replace(/\//g, '_')

mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(API_DUMP_DIR, { recursive: true })

/** 随机数工具：[min, max) 浮点 */
const rand = (min, max) => min + Math.random() * (max - min)

const startedAt = Date.now()
const tlog = (msg) => console.log(`[${Math.round((Date.now() - startedAt) / 1000)}s] ${msg}`)

const browser = await chromium.launch({
  headless: true,
  // WARP SOCKS 代理模式降级：workflow 注入 WARP_SOCKS 时 Chromium 走本地 socks5 代理
  ...(process.env.WARP_SOCKS ? { proxy: { server: process.env.WARP_SOCKS } } : {}),
})

/**
 * 应用层捕获 init script（在任何页面 JS 之前注入，每次导航自动重放）：
 *  1. 包装 XMLHttpRequest.prototype.open —— 实例上记录请求 URL；
 *  2. 包装 onreadystatechange setter —— axios 以此绑定响应处理，处理函数
 *     执行期间把实例 URL 放到 window.__currentXhrUrl（拦截器内的 JSON.parse
 *     与 XHR 处理同栈同步执行，可精确读到端点 URL）；
 *  3. 包装 JSON.parse —— 捕获含 returnCode 的网关明文（解密必经点），
 *     push 到 window.__apiCapture（数组元素 {t, url, parsed}）。
 *     一切异常静默吞掉，绝不影响页面自身行为。
 */
const API_HOOK_SCRIPT = `(() => {
  try {
    if (window.__apiCaptureInstalled) return
    window.__apiCaptureInstalled = true
    window.__apiCapture = []
    window.__currentXhrUrl = null

    const xhrProto = XMLHttpRequest.prototype
    const origOpen = xhrProto.open
    xhrProto.open = function (method, url) {
      try { this.__hookUrl = String(url) } catch (e) {}
      return origOpen.apply(this, arguments)
    }

    const desc = Object.getOwnPropertyDescriptor(xhrProto, 'onreadystatechange')
    if (desc && desc.configurable && desc.set && desc.get) {
      Object.defineProperty(xhrProto, 'onreadystatechange', {
        configurable: true,
        enumerable: true,
        get: function () { return desc.get.call(this) },
        set: function (fn) {
          if (typeof fn !== 'function') { desc.set.call(this, fn); return }
          const wrapped = function () {
            const prev = window.__currentXhrUrl
            window.__currentXhrUrl = this.__hookUrl || null
            try { return fn.apply(this, arguments) }
            finally { window.__currentXhrUrl = prev }
          }
          desc.set.call(this, wrapped)
        },
      })
    }

    const origParse = JSON.parse
    JSON.parse = function (text, reviver) {
      const result = origParse.call(JSON, text, reviver)
      try {
        if (result && typeof result === 'object' && !Array.isArray(result) &&
            (('returnCode' in result) || ('retCode' in result))) {
          window.__apiCapture.push({
            t: Date.now(),
            url: window.__currentXhrUrl || null,
            parsed: origParse.call(JSON, JSON.stringify(result)),
          })
          if (window.__apiCapture.length > 1200) window.__apiCapture.splice(0, 300)
        }
      } catch (e) {}
      return result
    }
  } catch (e) {}
})()`

/* ---------- 捕获分类（Node 侧，消费页面捕获缓冲） ---------- */

/**
 * 判定一条明文捕获属于哪个端点、解析出结构化信息。
 * 明文形态（逆向实证）：{ returnCode, returnMessage, data }，
 * data 即业务 rspBody：列表 = {page:{total,pageNumber}, beans:[]}（可能再包
 * 一层 data）；标准资费 = 数组或 {tariffList:[{tariffTable:{tHead,tBody}}]}。
 */
function classifyCapture(cap) {
  const parsed = cap.parsed || {}
  const url = String(cap.url || '')
  const body = parsed.rspBody ?? parsed.data

  // 列表分页：data(或 data.data) 内含 page/beans
  const d = body && typeof body === 'object' && !Array.isArray(body) ? body.data ?? body : null
  if (d && (d.page || Array.isArray(d.beans))) {
    return {
      kind: 'list',
      endpoint: url.includes('getTariffListInfo') ? 'getTariffListInfo' : 'list(other)',
      total: Number(d.page?.total ?? 0) || 0,
      pageNumber: Number(d.page?.pageNumber ?? 0) || 0,
      beans: Array.isArray(d.beans) ? d.beans : [],
    }
  }
  // 标准资费：全部表格组（官方页面只用第一组，此处全量提取）
  const tables = extractStandardTables(body)
  if (tables) {
    return { kind: 'standard', endpoint: 'getStandardlist', tables }
  }
  return { kind: 'other', endpoint: url || 'unknown' }
}

/** 从标准资费明文提取全部表格组（数组 / tariffList / data 再嵌套三种形态通吃） */
function extractStandardTables(body) {
  if (!body) return null
  let groups = null
  if (Array.isArray(body)) groups = body
  else if (Array.isArray(body.tariffList)) groups = body.tariffList
  else if (body.data && (Array.isArray(body.data) || Array.isArray(body.data?.tariffList))) {
    groups = Array.isArray(body.data) ? body.data : body.data.tariffList
  }
  if (!groups || !Array.isArray(groups)) return null
  const tables = []
  for (const g of groups) {
    const tt = g && g.tariffTable
    if (tt && Array.isArray(tt.tHead) && Array.isArray(tt.tBody)) {
      tables.push({
        title:
          (typeof g.tableTitle === 'string' && g.tableTitle) ||
          (typeof g.tariffName === 'string' && g.tariffName) ||
          (typeof g.title === 'string' && g.title) ||
          null,
        tHead: tt.tHead,
        tBody: tt.tBody,
      })
    }
  }
  return tables.length ? tables : null
}

/** 表格组 → 卡片数组（tHead 键名/位置两维解析，行字段映射 + 组名标注） */
function standardTablesToItems(tables) {
  const items = []
  for (const tbl of tables) {
    const heads = (tbl.tHead || []).filter(Boolean)
    const keys = heads.map((h) => Object.keys(h)[0])
    const titles = heads.map((h, i) => (keys[i] != null ? String(h[keys[i]]) : `列${i + 1}`))
    for (const row of tbl.tBody || []) {
      if (!row) continue
      const fields = {}
      titles.forEach((t, i) => {
        const v = row[keys[i]] ?? row[`field${i + 1}`] ?? ''
        if (String(v ?? '').trim() !== '') fields[t] = String(v).trim()
      })
      if (Object.keys(fields).length === 0) continue
      fields['资费类型'] = '标准资费'
      if (tbl.title) fields['所属表格'] = tbl.title
      const name =
        fields['资费名称'] ||
        fields['业务名称'] ||
        fields['项目'] ||
        fields['业务'] ||
        fields['服务名称'] ||
        Object.values(fields)[0] ||
        '未命名标准资费'
      items.push({ name, fields, usage: [], gray: {}, _sourceType: '标准资费' })
    }
  }
  return items
}

/**
 * 创建一个 worker（= 一个"虚拟用户"）：
 * 独立 browser context（独立 cookie/存储）、独立微随机视口、独立日志前缀与节奏序列。
 */
async function createWorker(id) {
  const viewport = {
    width: Math.round(rand(1346, 1386)),
    height: Math.round(rand(870, 930)),
  }
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${Math.round(
    rand(126, 129)
  )}.0.0.0 Safari/537.36`
  const context = await browser.newContext({ userAgent: ua, viewport })
  const page = await context.newPage()
  page.setDefaultTimeout(30000)
  await page.addInitScript(API_HOOK_SCRIPT)

  /* ---------- 应用层捕获状态（Node 侧聚合） ---------- */
  const api = {
    /** 当前归属类型 label（列表捕获的归属轴） */
    currentType: null,
    /** label → {total, beans:Map(beanJson→bean), pages, maxPageNumber, firstBeanKeys} */
    listByType: new Map(),
    /** 标准资费全部表格组（明文） */
    standardTables: null,
    standardCapturedAt: 0,
    /** 其他形态捕获数（诊断用） */
    other: 0,
    /** 端点命中统计（诊断用） */
    endpoints: new Map(),
  }

  /** 消费页面捕获缓冲并按端点/归属聚合 */
  function ingest(caps) {
    for (const cap of caps) {
      const info = classifyCapture(cap)
      const ep = info.endpoint || 'unknown'
      api.endpoints.set(ep, (api.endpoints.get(ep) || 0) + 1)
      if (info.kind === 'list') {
        const label = api.currentType || '（初始加载）'
        let e = api.listByType.get(label)
        if (!e) {
          e = { total: 0, beans: new Map(), pages: 0, maxPageNumber: 0, firstBeanKeys: null }
          api.listByType.set(label, e)
        }
        if (info.total > e.total) e.total = info.total
        if (info.pageNumber > e.maxPageNumber) e.maxPageNumber = info.pageNumber
        e.pages++
        if (!e.firstBeanKeys && info.beans.length) e.firstBeanKeys = Object.keys(info.beans[0])
        for (const b of info.beans) e.beans.set(JSON.stringify(b), b)
      } else if (info.kind === 'standard') {
        api.standardTables = info.tables
        api.standardCapturedAt = Date.now()
      } else {
        api.other++
      }
    }
  }

  /** 拉取页面捕获缓冲（导航瞬间会失败，静默跳过） */
  async function pullCaptures() {
    try {
      const caps = await page.evaluate(() => {
        const arr = window.__apiCapture || []
        const out = arr.slice()
        arr.length = 0
        return out
      })
      if (caps && caps.length) ingest(caps)
    } catch {
      /* 导航中执行上下文销毁等瞬态，忽略 */
    }
  }

  // 周期性拉取（2.5s）：与主流程异步交错，Playwright 命令队列天然串行安全
  const pullTimer = setInterval(() => {
    pullCaptures().catch(() => {})
  }, 2500)

  const w = {
    id,
    context,
    page,
    viewport,
    api,
    pullCaptures,
    ingest,
    stopPuller: () => clearInterval(pullTimer),
    log: (msg) => console.log(`[${Math.round((Date.now() - startedAt) / 1000)}s w${id}] ${msg}`),
    jitter: (minS, maxS) => page.waitForTimeout(rand(minS, maxS) * 1000),
  }
  w.log(`worker 启动：视口=${viewport.width}x${viewport.height}`)
  return w
}

/** 偶发鼠标漂移：视口内随机轨迹移动（约 40% 概率触发，为页面补充真实指针事件） */
async function mouseDrift(w) {
  if (Math.random() > 0.4) return
  await w.page.mouse.move(rand(80, w.viewport.width - 80), rand(60, w.viewport.height - 80), {
    steps: Math.floor(rand(3, 10)),
  })
}

/** 导航到公示页（带 1 次重试，网络偶发失败不至于直接崩掉整轮采集） */
async function navigate(w) {
  for (let i = 1; i <= 2; i++) {
    try {
      await w.page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
      return
    } catch (e) {
      if (i === 2) throw e
      w.log(`导航失败（${String(e.message).split('\n')[0]}），10s 后重试一次...`)
      await w.page.waitForTimeout(10000)
    }
  }
}

/** 等待加载指示消失（「努力加载中」文本不存在），轮询间隔也随机 */
async function waitIdle(w) {
  for (let i = 0; i < 15; i++) {
    const loading = await w.page.evaluate(() =>
      document.body.innerText.includes('努力加载中') ? '1' : '0'
    )
    if (loading === '0') break
    await w.jitter(1.5, 3)
  }
  await w.jitter(1.5, 3)
}

const countCards = (w) =>
  w.page.evaluate(() => document.querySelectorAll('.tariff-item-container').length)

/**
 * 真人式滚动收集，直到列表加载完成。
 *
 * 完成判定（v4.3 三重，按优先级）：
 *   1) 【total 神谕】捕获到的接口 page.total 已知 且 卡片数 ≥ total——接口声明的
 *      全部条目已在 DOM，短确认（2×5s 无新增）后收工。这是生产实测最重要的判据：
 *      v4.1/4.2 两轮生产运行中「stall 10 轮 + 3×长复查」在 WARP 慢批次下提前收工
 *      （营销活动 555/1032 即中断），外层再整列表重滚一遍极耗时（自愈轮 ~13 分钟）；
 *   2) 停滞 10 轮 + 已到真底 + 3 轮 8~15s 长复查无新增（total 未知时的兜底）；
 *   3) 0 卡片空转 12 轮（≈1 分钟）提前退出，交由外层类型级自愈/失败。
 *
 * 节奏（v4.3 提速，生产实测每页 ~6.5s 节奏拉 445 页要 48 分钟超时）：
 *   主循环每轮 = 直跳绝对底部（懒加载触发器）+ 1.6~3.0s 间歇（≈2.3s/页）；
 *   10% 概率插入 1~2 小步浏览 + 8% 概率阅读停留 4~8s——保持真人多样性的同时
 *   批量吞吐提速 ~2.5 倍（急性子用户按住 End 键翻列表的形态）。
 *
 * @param maxRounds 最大滚动轮数（SMOKE 模式传小值快速验证）
 * @param oracleTotal 动态取接口声明 total 的闭包（捕获已知时启用 total 神谕）
 */
async function scrollAll(w, maxRounds = 220, oracleTotal = null) {
  await waitIdle(w)
  const stallRounds = 10
  let stall = 0
  let last = 0
  let emptyRounds = 0
  for (let round = 0; round < maxRounds; round++) {
    const prev = await countCards(w)
    if (prev === 0) emptyRounds++
    else emptyRounds = 0
    if (emptyRounds >= 12) break
    // 10% 概率小步浏览（真人多样性；非每轮必做——v4.3 提速）
    if (Math.random() < 0.1) {
      const steps = 1 + Math.floor(Math.random() * 2)
      for (let s = 0; s < steps; s++) {
        await w.page.evaluate(() => {
          const h = window.innerHeight * (0.8 + Math.random() * 0.7)
          window.scrollBy({ top: h, behavior: 'instant' })
        })
        await w.jitter(0.8, 1.8)
      }
    }
    await mouseDrift(w)
    // 直跳绝对底部（模拟 End 键）——懒加载触发器
    await w.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await (Math.random() < 0.08 ? w.jitter(4, 8) : w.jitter(1.6, 3))
    const now = await countCards(w)
    stall = prev === now ? stall + 1 : 0
    last = now
    // total 神谕：接口声明全部到位即收工（2×5s 短确认防在途）
    const oracle = oracleTotal ? await Promise.resolve(oracleTotal()) : null
    if (oracle != null && now >= oracle && now !== 0) {
      let confirmed = true
      for (let r = 0; r < 2; r++) {
        await w.jitter(4, 7)
        const again = await countCards(w)
        if (again > now) {
          confirmed = false
          stall = 0
          last = again
          break
        }
      }
      if (confirmed) break
    }
    if (stall >= stallRounds && now !== 0) {
      const atBottom = await w.page.evaluate(
        () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 100
      )
      if (atBottom) {
        let confirmed = true
        for (let r = 0; r < 3; r++) {
          await w.jitter(8, 15)
          const again = await countCards(w)
          if (again > now) {
            confirmed = false
            stall = 0
            last = again
            break
          }
        }
        if (confirmed) break
      } else {
        stall = Math.floor(stall / 2)
      }
    }
  }
  // 平滑回到顶部（类型切换控件在页首；浏览完回看顶部也更像真人）
  await w.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
  await w.jitter(1.2, 2.5)
  return last
}

/** 重新导航（重置 Vue 状态）+ 选河北省 + 等待初始加载 */
async function resetToHebei(w) {
  await navigate(w)
  await w.jitter(8, 14)
  await mouseDrift(w)
  await w.page.evaluate(() => {
    document.querySelector('.prov-entry')?.click()
  })
  await w.jitter(1.5, 3)
  await w.page.evaluate(() => {
    const items = [...document.querySelectorAll('*')].filter(
      (e) => e.children.length === 0 && (e.innerText || '').trim() === '河北省'
    )
    items.forEach((e) => e.click())
  })
  await w.jitter(6, 10)
  await waitIdle(w)
  await w.pullCaptures()
  // 选省会触发 getStandardlist（分省页签标准资费选项的附加条件）；慢出口下
  // 稍等捕获到位（最多 ~24s；后续还有周期拉取 + 枚举重试 + 标准资费分支复检三层兜底）
  if (!w.api.standardTables) {
    for (let i = 0; i < 6 && !w.api.standardTables; i++) {
      await w.jitter(2.5, 4)
      await w.pullCaptures()
    }
  }
}

/** 提取当前页全部资费卡片（选择器经生产数据验证：tariffSerial chunk-837） */
async function extractCards(w) {
  return w.page.evaluate(() => {
    const cards = [...document.querySelectorAll('.tariff-item-container')]
    const out = []
    for (const c of cards) {
      const name = c.querySelector('.item-name')?.innerText?.trim() || ''
      const tips = [...c.querySelectorAll('.item-tips-list .tips-attr, .item-tips-list .tips-content')]
      const fields = {}
      let lastLabel = null
      for (const el of tips) {
        const txt = (el.innerText || '').trim()
        if (el.classList.contains('tips-attr')) {
          lastLabel = txt.replace(/[:：]\s*$/, '')
        } else if (lastLabel) {
          fields[lastLabel] = txt
          lastLabel = null
        }
      }
      const ta = c.querySelector('.table-area')
      const usage = []
      if (ta) {
        const parts = (ta.innerText || '').trim().split(/\n+/).filter(Boolean)
        for (let i = 0; i + 1 < parts.length; i += 2) usage.push({ label: parts[i], value: parts[i + 1] })
      }
      const gray = {}
      const grayText = c.querySelector('.list-gray')?.innerText || ''
      const labels = ['超出资费说明', '其他服务内容', '其他说明', '备注', '温馨提示']
      for (const lb of labels) {
        const re = new RegExp(lb + '[:：]\\s*')
        const m = grayText.match(re)
        if (m) {
          const start = m.index + m[0].length
          let end = grayText.length
          for (const lb2 of labels) {
            if (lb2 === lb) continue
            const re2 = new RegExp(lb2 + '[:：]')
            const m2 = grayText.slice(start).match(re2)
            if (m2) end = Math.min(end, start + m2.index)
          }
          gray[lb] = grayText.slice(start, end).trim()
        }
      }
      out.push({ name, fields, usage, gray })
    }
    return out
  })
}

/* ---------- 资费类型下拉操作（NavBarNew chunk-155 MySelect DOM） ---------- */

/** 当前选中的类型文本（.select-box 展示文案，选中验证用） */
async function readSelectedType(w) {
  return w.page.evaluate(() => {
    const root = (() => {
      const labels = [...document.querySelectorAll('.select-label')]
      const lb = labels.find((el) => (el.innerText || '').trim().replace(/[:：]/, '') === '资费类型')
      let r = null
      if (lb) {
        const box = lb.parentElement?.querySelector('.select-box')
        r = box ? box.closest('.select-container') || lb.parentElement : lb.parentElement
      }
      if (!r) {
        const sb = document.querySelector('.select-box')
        r = sb ? sb.closest('.select-container') || sb.parentElement : null
      }
      return r
    })()
    if (!root) return null
    const box = root.querySelector('.select-box')
    return box ? (box.innerText || '').trim() : null
  })
}

/** 下拉当前是否展开（存在可见 .select-item） */
async function isDropdownOpen(w) {
  return (
    (
      await w.page.evaluate(() => {
        const root = typeSelectRoot()
        function typeSelectRoot() {
          const labels = [...document.querySelectorAll('.select-label')]
          const lb = labels.find((el) => (el.innerText || '').trim().replace(/[:：]/, '') === '资费类型')
          let r = null
          if (lb) {
            const box = lb.parentElement?.querySelector('.select-box')
            r = box ? box.closest('.select-container') || lb.parentElement : lb.parentElement
          }
          if (!r) {
            const sb = document.querySelector('.select-box')
            r = sb ? sb.closest('.select-container') || sb.parentElement : null
          }
          return r
        }
        if (!root) return 0
        const visible = [...root.querySelectorAll('.select-item')].filter((e) => e.offsetParent !== null)
        return visible.length
      })
    ) > 0
  )
}

/**
 * 打开类型下拉——★幂等（v4 事故修复）：先探测是否已展开，展开则直接返回，
 * 绝不二次点击 .select-box（v3 在枚举后下拉保持展开，主循环首次再点把下拉
 * 收起 → 首个类型「选项消失」跳过 → 套餐 0 条照常推送 → 502 套餐全被误判下线）。
 */
async function openTypeDropdown(w) {
  if (await isDropdownOpen(w)) return 'ok'
  await mouseDrift(w)
  const res = await w.page.evaluate(() => {
    const labels = [...document.querySelectorAll('.select-label')]
    const lb = labels.find((el) => (el.innerText || '').trim().replace(/[:：]/, '') === '资费类型')
    let box = null
    if (lb) box = lb.parentElement?.querySelector('.select-box')
    if (!box) box = document.querySelector('.select-box')
    if (!box) return 'nf'
    box.click()
    return 'ok'
  })
  await w.jitter(1.2, 2.5)
  return res
}

/** 收起下拉（再点一次 box；未展开则不动） */
async function closeTypeDropdown(w) {
  if (!(await isDropdownOpen(w))) return
  await w.page.evaluate(() => {
    const sb = document.querySelector('.select-box')
    sb?.click()
  })
  await w.jitter(0.8, 1.6)
}

/** 枚举当前展开下拉中的全部类型选项（可见 .select-item 文本，含'标准资费'） */
async function listTypeOptions(w) {
  return w.page.evaluate(() => {
    const root = (() => {
      const labels = [...document.querySelectorAll('.select-label')]
      const lb = labels.find((el) => (el.innerText || '').trim().replace(/[:：]/, '') === '资费类型')
      let r = null
      if (lb) {
        const box = lb.parentElement?.querySelector('.select-box')
        r = box ? box.closest('.select-container') || lb.parentElement : lb.parentElement
      }
      if (!r) {
        const sb = document.querySelector('.select-box')
        r = sb ? sb.closest('.select-container') || sb.parentElement : null
      }
      return r
    })()
    if (!root) return []
    return [...root.querySelectorAll('.select-item')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => (e.innerText || '').trim())
      .filter(Boolean)
  })
}

/** 点击指定类型选项（需先 openTypeDropdown），返回 'ok' | 'nf' */
async function clickTypeOption(w, label) {
  return w.page.evaluate(
    (t) => {
      const root = (() => {
        const labels = [...document.querySelectorAll('.select-label')]
        const lb = labels.find((el) => (el.innerText || '').trim().replace(/[:：]/, '') === '资费类型')
        let r = null
        if (lb) {
          const box = lb.parentElement?.querySelector('.select-box')
          r = box ? box.closest('.select-container') || lb.parentElement : lb.parentElement
        }
        if (!r) {
          const sb = document.querySelector('.select-box')
          r = sb ? sb.closest('.select-container') || sb.parentElement : null
        }
        return r
      })()
      if (!root) return 'nf'
      const items = [...root.querySelectorAll('.select-item')].filter((e) => e.offsetParent !== null)
      const hit = items.find((e) => (e.innerText || '').trim() === t)
      if (hit) {
        hit.click()
        return 'ok'
      }
      return 'nf'
    },
    label
  )
}

/**
 * 选择指定类型（幂等下拉 + 点击 + 选中验证 + 归属切换）：
 *  - 点击后读 .select-box 文案验证选中生效，失败重试一次（再开下拉再点）；
 *  - 选中即切换 w.api.currentType —— 后续列表明文捕获归属到该类型。
 */
async function selectType(w, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await openTypeDropdown(w)
    const res = await clickTypeOption(w, label)
    // ★点击即切换归属：页 1 响应在 jitter 期间到达也能正确归属（v4.1 修复
    //   「归属滞后一拍」——否则首页明文被周期拉取器归给上一个类型）
    if (res === 'ok') w.api.currentType = label
    await w.jitter(8, 14)
    if (res === 'nf') return 'nf'
    await w.pullCaptures()
    const shown = await readSelectedType(w)
    if (!shown || shown.includes(label)) return 'ok'
    w.log(`选中验证失败（box 显示「${shown}」≠「${label}」），${attempt === 1 ? '重试一次' : '放弃'}`)
  }
  return 'verify-failed'
}

/* ---------- 标准资费 DOM 兜底（优先用捕获明文，此路径仅兜底） ---------- */

/** DOM 兜底：从 vxe-table 渲染结果提取标准资费行（宽松选择器：free-cont-box 内任意表格） */
async function standardItemsFromDom(w) {
  return w.page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.free-cont-box, .freeContent-table')]
    const items = []
    for (const b of boxes) {
      const table =
        b.querySelector('.vxe-table--main-wrapper table') ||
        b.querySelector('table') ||
        b.closest('table')
      if (!table) continue
      const title = (b.querySelector('.free-cont-title')?.innerText || '').trim() || null
      const ths = [...table.querySelectorAll('thead th, thead td')].map((th) =>
        (th.innerText || '').trim()
      )
      for (const tr of [...table.querySelectorAll('tbody tr')]) {
        const cells = [...tr.querySelectorAll('td')].map((td) => (td.innerText || '').trim())
        if (!cells.some(Boolean)) continue
        const fields = {}
        cells.forEach((c, i) => {
          if (c) fields[ths[i] || `列${i + 1}`] = c
        })
        fields['资费类型'] = '标准资费'
        if (title) fields['所属表格'] = title
        items.push({
          name: fields['资费名称'] || cells.find(Boolean) || '未命名标准资费',
          fields,
          usage: [],
          gray: {},
          _sourceType: '标准资费',
        })
      }
    }
    return items
  })
}

/* ---------- 采集主流程 ---------- */

async function saveJson(w, cards, filename) {
  const path = join(OUT_DIR, filename)
  writeFileSync(path, JSON.stringify(cards, null, 1), 'utf-8')
  w.log(`saved: ${path} (${cards.length} cards)`)
}

/** 增量写齐全性报告 + beans 归档（每类型完成即落盘：超时中断也能留下证据链） */
function writeIncrementalReport(w, results, done = false) {
  const report = {
    fetchedAt: new Date().toISOString(),
    complete: done,
    scope: '个人 × 河北分省',
    capture: {
      mechanism: 'JSON.parse 应用层明文捕获（isWX 通道解密必经点）+ XHR URL 关联',
      endpoints: Object.fromEntries(w.api.endpoints),
      otherCaptures: w.api.other,
      initialType: '套餐',
    },
    types: results,
    listByType: [...w.api.listByType.entries()].map(([label, e]) => ({
      label,
      total: e.total,
      pages: e.pages,
      maxPageNumber: e.maxPageNumber,
      beanUnique: e.beans.size,
      firstBeanKeys: e.firstBeanKeys,
    })),
    standardFromApi: !!w.api.standardTables,
    standardGroups: w.api.standardTables
      ? w.api.standardTables.map((t) => ({ title: t.title, rows: t.tBody.length }))
      : null,
  }
  try {
    writeFileSync(join(API_DUMP_DIR, 'api-report.json'), JSON.stringify(report, null, 2), 'utf-8')
    for (const [label, e] of w.api.listByType) {
      if (e.beans.size) {
        writeFileSync(
          join(API_DUMP_DIR, `beans-${fileSafe(label)}.json`),
          JSON.stringify([...e.beans.values()], null, 1),
          'utf-8'
        )
      }
    }
    if (w.api.standardTables) {
      writeFileSync(
        join(API_DUMP_DIR, 'standard-raw.json'),
        JSON.stringify(w.api.standardTables, null, 2),
        'utf-8'
      )
    }
  } catch {
    /* 报告写入失败不影响主流程 */
  }
}

/**
 * 唯一阶段：个人资费 / 河北资费 × 全部类型
 * （动态枚举 + 应用层明文捕获齐全性校验）
 */
async function phasePersonalHebei(w) {
  w.log('=== PHASE: 个人资费/河北资费 × 全部类型 ===')
  await resetToHebei(w)
  await w.page.evaluate(() => document.querySelectorAll('.range-tab')[1]?.click())
  // ★点击页签后立即归属默认类型：页签切换会以当前类型重拉列表（page 1 明文
  //   ~1s 内到达，须赶在周期拉取器之前定归属，否则被归进「初始加载」空桶）。
  //   随后读 box 文案校正；即便读出的不是默认值也无碍——主循环处理该类型时
  //   selectType 会重新触发 page 1 并正确归属
  w.api.currentType = '套餐'
  await w.jitter(8, 12)
  const shownType = await readSelectedType(w)
  if (shownType && !shownType.includes('套餐')) {
    w.log(`⚠ 页签切换后选中类型为「${shownType}」（非默认套餐），归属已跟随校正`)
    w.api.currentType = shownType
  } else {
    w.log('类型下拉当前选中（初始归属）：套餐')
  }
  await waitIdle(w)
  await w.pullCaptures()

  // 枚举类型下拉（幂等打开；3 次重试）
  let options = []
  for (let i = 0; i < 3; i++) {
    await openTypeDropdown(w)
    options = await listTypeOptions(w)
    if (options.length > 0) break
    await closeTypeDropdown(w)
    await w.jitter(4, 8)
  }
  await closeTypeDropdown(w) // ★枚举完毕务必收起，保证主循环状态确定
  if (options.length === 0) throw new Error('类型下拉枚举失败（页面结构可能已变化）')
  w.log(`类型下拉选项（${options.length} 个）: ${options.join(' / ')}`)

  if (SMOKE) {
    // 冒烟：验证选项枚举 + 切一个非默认类型 + 选中验证 + 卡片选择器 + 明文捕获
    const probe = options.find((o) => o !== '套餐' && o !== '标准资费') || options[0]
    const sel = probe === '套餐' ? 'skip' : await selectType(w, probe)
    await waitIdle(w)
    await scrollAll(w, 3)
    await w.pullCaptures()
    const n = await countCards(w)
    const listTypes = [...w.api.listByType.keys()]
    w.log(
      `SMOKE 探测类型「${probe}」: ${n} cards（选中=${sel}）；` +
        `明文捕获: 列表类型=[${listTypes.join('，')}] 标准资费=${w.api.standardTables ? '已捕获' : '未见'}`
    )
    if (n === 0 && !w.api.standardTables && w.api.listByType.size === 0) {
      throw new Error('SMOKE 未观察到卡片与任何明文捕获（选择器或页面结构可能已变化）')
    }
    return 'smoke-ok'
  }

  /* 全量：逐类型采集（保持下拉顺序，跳过重复） */
  const results = []
  const done = new Set()
  for (const label of options) {
    if (done.has(label)) continue
    done.add(label)

    /* ---- 标准资费：不走列表 API，数据源 = 捕获明文（全部表格组） ---- */
    if (label === '标准资费') {
      await selectType(w, label)
      await w.jitter(5, 9)
      await w.pullCaptures()
      let items = w.api.standardTables ? standardTablesToItems(w.api.standardTables) : null
      let note = w.api.standardTables ? `明文 ${w.api.standardTables.length} 表格组` : ''
      if (!items || items.length === 0) {
        // 兜底 1：DOM vxe-table
        const domItems = await standardItemsFromDom(w)
        if (domItems.length) {
          items = domItems
          note = `DOM 兜底 ${domItems.length} 行`
        } else {
          // 兜底 2：再等一轮捕获（慢出口）
          for (let i = 0; i < 6 && !w.api.standardTables; i++) {
            await w.jitter(3, 5)
            await w.pullCaptures()
          }
          items = w.api.standardTables ? standardTablesToItems(w.api.standardTables) : null
          if (items && items.length) note = `慢捕获 ${w.api.standardTables.length} 表格组`
        }
      }
      if (items && items.length) {
        await saveJson(w, items, `p_h_${fileSafe(label)}.json`)
        results.push({ label, count: items.length, apiTotal: items.length, note })
      } else {
        // 选项存在却拿不到数据：页面声明有标准资费但捕获/DOM 均空 → 判失败（宁缺毋滥）
        results.push({ label, count: 0, apiTotal: null, note: '选项存在但明文/DOM 均未取到数据' })
      }
      await w.jitter(3, 6)
      continue
    }

    /* ---- 常规列表类型 ---- */
    // 已选中类型不重复点击（同值选择不触发重载，滚动收集现有列表即可）
    const already = (await readSelectedType(w)) || ''
    const sel = already.includes(label) ? 'already' : await selectType(w, label)
    await waitIdle(w)
    if (sel === 'nf') {
      w.log(`${label}: 下拉选项消失，跳过`)
      results.push({ label, count: 0, apiTotal: null, note: '选项不可用' })
      continue
    }
    if (sel === 'verify-failed') {
      results.push({ label, count: 0, apiTotal: null, note: '选中验证失败' })
      continue
    }

    const typeOracle = () => w.api.listByType.get(label)?.total ?? null
    let count = await scrollAll(w, 220, typeOracle)
    await w.pullCaptures()
    let entry = w.api.listByType.get(label)
    // 接口已声明 0 条的空类型无需重试；其余 0 cards 场景冷却 60~90s 重选重抓一次
    if (count === 0 && !(entry && entry.total === 0)) {
      w.log(`${label}: 0 cards——冷却后重试一次`)
      await w.jitter(60, 90)
      await selectType(w, label)
      await waitIdle(w)
      count = await scrollAll(w, 220, typeOracle)
      await w.pullCaptures()
      entry = w.api.listByType.get(label)
    }
    let cards = count > 0 ? await extractCards(w) : null
    /** 唯一方案编号数（生产实测 DOM 节点数与唯一编号数一致，无重复卡片） */
    const uniqueCount = (cs) => {
      if (!cs) return 0
      const codes = cs.map((c) => c.fields?.['方案编号']).filter(Boolean)
      return codes.length ? new Set(codes).size : cs.length
    }
    let unique = uniqueCount(cards)
    // 接口齐全性自愈：唯一编号数 < 捕获 total → 追加一轮滚动（在途批次/翻页缺失兜底）
    let apiTotal = entry ? entry.total : null
    if (apiTotal != null && unique < apiTotal && !(entry && entry.total === 0)) {
      w.log(`${label}: 唯一 ${unique} < 明文 total ${apiTotal}——追加一轮滚动自愈`)
      count = await scrollAll(w, 220, typeOracle)
      await w.pullCaptures()
      entry = w.api.listByType.get(label)
      apiTotal = entry ? entry.total : null
      cards = count > 0 ? await extractCards(w) : cards
      unique = uniqueCount(cards)
    }
    // 诊断：DOM 卡片编号 vs 捕获 beans id/tariffSeqno 交叉对照（生产数据源一致性审计）
    let beanCross = ''
    if (entry && cards) {
      const beanIds = new Set()
      for (const b of entry.beans.values()) {
        if (b && typeof b === 'object') {
          if (b.id != null) beanIds.add(String(b.id))
          if (b.tariffSeqno != null) beanIds.add(String(b.tariffSeqno))
        }
      }
      const domCodes = new Set(cards.map((c) => c.fields?.['方案编号']).filter(Boolean))
      if (beanIds.size && domCodes.size) {
        let domOnly = 0
        let beanOnly = 0
        for (const c of domCodes) if (!beanIds.has(c)) domOnly++
        for (const b of beanIds) if (!domCodes.has(b)) beanOnly++
        beanCross = `，DOM独有 ${domOnly}/beans独有 ${beanOnly}`
      }
    }
    w.log(
      `${label}: DOM ${count} / 唯一 ${unique}（total=${apiTotal ?? '未知'}，beans=${entry ? entry.beans.size : '—'}${beanCross}）`
    )
    if (cards) {
      for (const c of cards) c._sourceType = label
      await saveJson(w, cards, `p_h_${fileSafe(label)}.json`)
    }
    results.push({ label, count: unique, domCount: count, apiTotal, note: '' })
    writeIncrementalReport(w, results) // 超时中断也能留下已采类型的报告
    await w.jitter(2, 4) // 类型之间的浏览间歇
  }

  w.stopPuller()
  await w.pullCaptures()

  /* ---------- 应用层捕获齐全性报告（严格门禁，阻断推送） ---------- */
  writeIncrementalReport(w, results, true) // 最终版（complete=true；beans/标准资费归档同函数内）

  tlog('── 应用层捕获齐全性报告 ──')
  tlog(
    `  捕获通道: ${[...w.api.endpoints.entries()].map(([k, v]) => `${k}×${v}`).join('，') || '（无捕获！）'}`
  )
  let failed = 0
  for (const r of results) {
    const flag =
      r.count === 0
        ? r.apiTotal === 0
          ? '✓ 空类型（接口声明 0 条）'
          : `✗ FAILED（0 条${r.apiTotal != null ? `，接口声明 ${r.apiTotal} 条` : '，捕获未知'}）`
        : r.apiTotal == null
          ? '⚠ 完整（捕获未知，DOM 有数据）'
          : r.count >= r.apiTotal
            ? '✓ 完整'
            : `✗ FAILED（缺 ${r.apiTotal - r.count} 条）`
    if (flag.includes('✗')) failed++
    tlog(`  ${r.label}: 抓取 ${r.count} / 接口 ${r.apiTotal ?? '—'} ${flag}${r.note ? `（${r.note}）` : ''}`)
  }
  if (failed > 0) {
    tlog(`=== FAILED：${failed} 个类型不达标（宁缺毋滥，阻断当日推送）===`)
    process.exitCode = 1
    return
  }
  // 至少要有数据（全空大概率页面改版）
  const totalCards = results.reduce((s, r) => s + r.count, 0)
  if (totalCards === 0) {
    tlog('=== FAILED：全部类型 0 卡片（页面结构可能已变化）===')
    process.exitCode = 1
    return
  }
  tlog(`齐全性校验通过：${results.length} 个类型合计 ${totalCards} 条`)
}

const TASKS = [{ label: '个人×河北全类型', run: phasePersonalHebei }]

tlog(
  `启动：模式=${SMOKE ? 'SMOKE（快速冒烟·单 worker）' : 'FULL（个人×河北 × 全部类型）'}，` +
    `任务=${TASKS.map((t) => t.label).join(' / ')}` +
    (process.env.WARP_SOCKS ? `，代理=${process.env.WARP_SOCKS}` : '，出口=TUN 直连') +
    (process.env.SCRAPE_URL ? `，目标=${URL}` : '')
)

/* ---------- worker pool（当前单阶段=单 worker） ---------- */
let nextTask = 0
const settled = await Promise.allSettled([
  (async () => {
    const w = await createWorker(1)
    try {
      while (true) {
        const idx = nextTask++
        if (idx >= TASKS.length) break
        const task = TASKS[idx]
        w.log(`领取任务: ${task.label}`)
        if (idx > 0) await w.jitter(8, 15)
        const r = await task.run(w)
        if (SMOKE && r === 'smoke-ok') {
          w.log(
            'SMOKE 通过 ✓ 导航 + 河北选择 + 页签切换 + 类型下拉枚举/幂等 + 明文捕获通道全部健康'
          )
          w.stopPuller()
          await w.context.close()
          return 'smoke-ok'
        }
        await w.jitter(6, 12)
      }
      w.stopPuller()
      await w.context.close()
    } catch (e) {
      w.stopPuller()
      await w.context.close().catch(() => {})
      throw e
    }
  })(),
])

await browser.close()

const failures = settled.filter((s) => s.status === 'rejected')
if (failures.length > 0) {
  for (const f of failures) {
    console.error(`[worker 失败] ${f.reason && f.reason.message ? f.reason.message : f.reason}`)
  }
  tlog(`=== FAILED（worker 异常退出）===`)
  process.exit(1)
}

if (process.exitCode) process.exit(process.exitCode)
tlog(`=== ALL DONE（总耗时 ${Math.round((Date.now() - startedAt) / 1000)}s）===`)
