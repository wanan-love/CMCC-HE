/**
 * 中国移动河北资费公示抓取 —— GitHub Actions / 本地通用版（Playwright）
 * 运行: node scripts/scrape.mjs   （需先: npm i playwright && npx playwright install --with-deps chromium）
 * 冒烟: SCRAPE_SMOKE=1 node scripts/scrape.mjs  （单 worker 验证导航+选择器健康，约 1 分钟，不落盘）
 *
 * 采集范围（2026-09 按需求收敛）：仅「个人资费 · 河北省专属」——
 *   不做全网业务、不做政企业务。单个列表页签完整真人节奏遍历，约 3~8 分钟
 *   （视列表长度与出口网络状况；原 4 阶段全量版需 20~30 分钟）。
 *
 * 网络出口：GitHub Actions 中由 workflow 先连接 Cloudflare WARP（warp-cli connect 隧道接管全机流量），
 *           Chromium 的全部请求自然经 WARP 出口，避免数据中心 IP 直接访问公示页被风控。
 *           若 runner 网络限制 TUN 隧道，workflow 会自动降级 SOCKS 代理模式并注入 WARP_SOCKS 环境变量，
 *           本脚本读取该变量让 Chromium 走 socks5 代理（效果等价，推送 API 走直连）。
 *
 * worker 池结构说明：当前仅 1 个采集阶段（个人×河北），默认单 worker 串行；
 *   保留 worker pool 骨架（SCRAPE_CONCURRENCY 可调，1~4），未来若恢复多阶段/多类型并行
 *   只需向 TASKS 数组追加工作单元，每个 worker 即独立 browser context（独立 cookie/
 *   localStorage、独立微随机视口、独立随机节奏序列 = 同一 WARP 出口后的多个真实用户）。
 *
 * 真人节奏（防风控核心，处处随机不可预测；每个 worker 各自独立）：
 *   1. 所有等待均带随机抖动 jitter(min,max)——没有两次运行的节奏相同；
 *   2. 滚动是「浏览式」而非「机器式」：每轮 1~3 小步滚动 + 轮末直跳绝对底部（懒加载触发器），
 *      步间 0.8~1.8s，轮间 2~5s，15% 概率 5~9s「阅读停留」；
 *   3. 切页签 8~16s、重试冷却 60~90s 大间隔随机；
 *   4. 视口尺寸每个 worker 独立微随机（宽 1346~1386 / 高 870~930）；
 *   5. 偶发鼠标轨迹漂移（mouseDrift），补充真实指针事件。
 *
 * 输出: seed/p_h_all.json（JSON 数组：[{name, fields, usage, gray}]，
 *   与 agent-browser 版结构一致，供 normalize.mjs 消费）
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = process.env.SCRAPE_OUT_DIR || join(__dirname, '..', 'seed')
const SMOKE = !!process.env.SCRAPE_SMOKE
const URL =
  'https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html?pageId=834148205904408576&prov=531'
// worker 数（SMOKE 固定单 worker；常规默认 1——单阶段无需并行，结构上仍支持 1~4）
const CONCURRENCY = SMOKE
  ? 1
  : Math.max(1, Math.min(4, parseInt(process.env.SCRAPE_CONCURRENCY || '1', 10)))

mkdirSync(OUT_DIR, { recursive: true })

/** 随机数工具：[min, max) 浮点 */
const rand = (min, max) => min + Math.random() * (max - min)

const startedAt = Date.now()
const tlog = (msg) => console.log(`[${Math.round((Date.now() - startedAt) / 1000)}s] ${msg}`)

const browser = await chromium.launch({
  headless: true,
  // WARP SOCKS 代理模式降级：workflow 注入 WARP_SOCKS 时 Chromium 走本地 socks5 代理
  // （context 自动继承 launch 级 proxy，每个 worker 无需重复配置）
  ...(process.env.WARP_SOCKS ? { proxy: { server: process.env.WARP_SOCKS } } : {}),
})

/**
 * 创建一个 worker（= 一个"虚拟用户"）：
 * 独立 browser context（独立 cookie/存储）、独立微随机视口、独立日志前缀与节奏序列。
 */
async function createWorker(id) {
  // 视口每个 worker 微随机（同为桌面画像，彼此指纹不同）
  const viewport = {
    width: Math.round(rand(1346, 1386)),
    height: Math.round(rand(870, 930)),
  }
  // UA 主版本微随机（126~128，真实世界大量并存）
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${Math.round(
    rand(126, 129)
  )}.0.0.0 Safari/537.36`
  const context = await browser.newContext({ userAgent: ua, viewport })
  const page = await context.newPage()
  page.setDefaultTimeout(30000)

  const w = {
    id,
    context,
    page,
    viewport,
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
 * 真人式滚动收集：每轮若干小步浏览 + 直跳绝对底部（触发懒加载的关键），
 * 直到卡片数连续 8 轮无增长且已到达页面真实底部。
 *
 * 关键教训（生产实测）：懒加载以「到达/接近底部」为触发条件；纯小步平滑滚动
 * （smooth scrollBy 会被后续调用打断，实际位移远小于预期）可能始终到不了底部，
 * 且慢网络（WARP/跨境）下批次在途时停滞计数即成立 → 提前终止漏抓（首跑 781/3109）。
 * 故：① 每轮末尾直跳绝对底部确保触发；② 停滞阈值 8 轮 + 真底校验（不在底部则减半继续）。
 * @param maxRounds 最大滚动轮数（SMOKE 模式传小值快速验证）
 */
async function scrollAll(w, maxRounds = 120) {
  await waitIdle(w)
  const stallRounds = 10
  let stall = 0
  let last = 0
  for (let round = 0; round < maxRounds; round++) {
    const prev = await countCards(w)
    // 一轮 = 1~3 个小步（instant 位移，避免 smooth 被打断）模拟滑动读内容
    const steps = 1 + Math.floor(Math.random() * 3)
    for (let s = 0; s < steps; s++) {
      await w.page.evaluate(() => {
        const h = window.innerHeight * (0.8 + Math.random() * 0.7)
        window.scrollBy({ top: h, behavior: 'instant' })
      })
      await w.jitter(0.8, 1.8)
    }
    await mouseDrift(w)
    // 直跳绝对底部（模拟 End 键）——懒加载触发器
    await w.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    // 轮间停顿：常规 2~5s；15% 概率 5~9s「阅读停留」——给在途批次足够到达时间
    await (Math.random() < 0.15 ? w.jitter(5, 9) : w.jitter(2, 5))
    const now = await countCards(w)
    stall = prev === now ? stall + 1 : 0
    last = now
    if (stall >= stallRounds && now !== 0) {
      // 真底校验：视口确在底部才认定完成
      const atBottom = await w.page.evaluate(
        () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 100
      )
      if (atBottom) {
        // 慢出口（WARP/跨境）在途批次兜底：到底后最多 3 轮长停顿复查（每轮 8~15s），
        // 任一轮有新增 → 计数清零回主循环继续滚。生产实测（2026-09-04 首跑）：WARP TUN
        // 出口下懒加载批次延迟可超 60s，单次复查窗口不足 → 150/502 漏抓；
        // 3 轮复查 ≈ 24~45s 额外窗口且可多次触发，覆盖慢批次绝大多数到达场景。
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
        if (confirmed) break // 连续 3 轮无新增才认定完成
      } else {
        stall = Math.floor(stall / 2) // 不在底部 → 减半计数继续滚动
      }
    }
  }
  // 平滑回到顶部（页签控件在页首；浏览完回看顶部也更像真人）
  await w.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
  await w.jitter(1.2, 2.5)
  return last
}

/** 重新导航（重置 Vue 状态）+ 选河北省 + 等待初始加载 */
async function resetToHebei(w) {
  await navigate(w)
  await w.jitter(8, 14) // 打开页面先"看一看"
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
}

/** 提取当前页全部资费卡片（与 v2.sh 的 EXTRACT_JS 同构，选择器经生产数据验证） */
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

async function saveJson(w, cards, filename) {
  const path = join(OUT_DIR, filename)
  writeFileSync(path, JSON.stringify(cards, null, 1), 'utf-8')
  w.log(`saved: ${path} (${cards.length} cards)`)
}

/* ---------- 采集阶段（独立工作单元，可被任意 worker 认领） ---------- */

/** 唯一阶段：个人资费 / 河北资费（全部列表） */
async function phasePersonalHebei(w) {
  w.log('=== PHASE: 个人资费/河北资费 ===')
  await resetToHebei(w)
  await w.page.evaluate(() => document.querySelectorAll('.range-tab')[1]?.click())
  await w.jitter(10, 16)
  await waitIdle(w)
  let count = await scrollAll(w, SMOKE ? 3 : 120)
  if (!SMOKE && count === 0) {
    // 列表级自愈：0 cards（限流/慢批次）——冷却 60~90s 后重切页签重抓一次
    w.log('personal/hebei/all: 0 cards——冷却后重试一次')
    await w.jitter(60, 90)
    await w.page.evaluate(() => document.querySelectorAll('.range-tab')[1]?.click())
    await w.jitter(10, 16)
    await waitIdle(w)
    count = await scrollAll(w, 120)
  }
  w.log(`personal/hebei/all: ${count} cards`)
  const cards = count > 0 ? await extractCards(w) : null
  if (SMOKE) {
    if (!cards) throw new Error('SMOKE 未抓到任何卡片（选择器或页面结构可能已变化）')
    // 冒烟只验证健康，不落盘（避免覆盖 seed/ 下的全量数据）
    w.log(`SMOKE 样本（${cards.length} cards）: ${cards.slice(0, 3).map((c) => c.name).join(' / ')}`)
    return 'smoke-ok'
  }
  if (cards) await saveJson(w, cards, 'p_h_all.json')
}

const TASKS = [{ label: '个人×河北', run: phasePersonalHebei }]

tlog(
  `启动：模式=${SMOKE ? 'SMOKE（快速冒烟·单 worker）' : `FULL（个人×河北 · ${CONCURRENCY} worker）`}，` +
    `任务=${TASKS.map((t) => t.label).join(' / ')}` +
    (process.env.WARP_SOCKS ? `，代理=${process.env.WARP_SOCKS}` : '，出口=TUN 直连')
)

/* ---------- worker pool：N 个"虚拟用户"并行认领阶段（当前单阶段=单 worker） ---------- */
let nextTask = 0
const settled = await Promise.allSettled(
  Array.from({ length: CONCURRENCY }, (_, i) =>
    (async () => {
      const w = await createWorker(i + 1)
      try {
        while (true) {
          const idx = nextTask++
          if (idx >= TASKS.length) break
          const task = TASKS[idx]
          w.log(`领取任务: ${task.label}`)
          if (idx > 0) await w.jitter(8, 15) // 阶段间大间隔（首个任务无需）
          const r = await task.run(w)
          if (SMOKE && r === 'smoke-ok') {
            w.log('SMOKE 通过 ✓ 导航 + 河北选择 + 页签切换 + 滚动 + 卡片选择器全部健康')
            await w.context.close()
            return 'smoke-ok'
          }
          await w.jitter(6, 12) // 任务完成后的浏览间歇
        }
        await w.context.close()
      } catch (e) {
        await w.context.close().catch(() => {})
        throw e
      }
    })()
  )
)

await browser.close()

const failures = settled.filter((s) => s.status === 'rejected')
if (failures.length > 0) {
  for (const f of failures) {
    console.error(`[worker 失败] ${f.reason && f.reason.message ? f.reason.message : f.reason}`)
  }
  tlog(`=== FAILED（${failures.length}/${CONCURRENCY} 个 worker 失败）===`)
  process.exit(1)
}

tlog(`=== ALL DONE（总耗时 ${Math.round((Date.now() - startedAt) / 1000)}s）===`)
