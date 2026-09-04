/**
 * 河北移动资费公示页离线 mock 站点 —— scrape.mjs v4 全链路回归用
 *
 * 背景：沙箱出口 IP 被 10086.cn 系全线封锁（2026-09-04 起，何时解封未知），
 * 无法对真实公示页做本地验证；而 v3 正因「未经真实环境验证」上线翻车
 * （下拉切换 bug + isWX 加密通道拦截失效）。本 mock 站点复刻真实页面的
 * 【关键机制】，让 scrape.mjs 的每条代码路径都能离线跑通：
 *
 *   1. isWX 加密通道形态：mock 的「API」返回 {body:'<base64 密文>'} 信封，
 *      页面 JS 用 atob 解出明文后 JSON.parse —— 与真实页 chunk-common.js
 *      响应拦截器（F6 解密 → JSON.parse）走同一条捕获必经之路；
 *   2. MySelect 下拉（select-label/select-box/select-item + offsetParent
 *      可见性）+ 点击 box 展开再点收起的 toggle 行为；
 *   3. 懒加载列表（scroll-flag + 每页 5 条 + 「努力加载中」文案）；
 *   4. 选省（prov-entry → 河北省）、页签（range-tab）、标准资费表格视图
 *      （free-cont-box + vxe-table--main-wrapper）；
 *   5. getStandardlist 返回【两个表格组】（官方页只用第一组，v4 要全量提取）。
 *
 * 运行: node scripts/mock-site.mjs   （http://localhost:3939/tariff.html）
 * 验证: SCRAPE_URL=http://localhost:3939/tariff.html node scripts/scrape.mjs
 *       SCRAPE_URL=http://localhost:3939/tariff.html SCRAPE_SMOKE=1 node scripts/scrape.mjs
 */
import { createServer } from 'node:http'

const PORT = 3939

/* ---------- mock 数据 ---------- */

const TYPES = ['套餐', '加装包', '营销活动', '港澳台/国际资费', '标准资费']

/** 每类型的条目数（故意各不相同，验证分页/总数/去重） */
const TYPE_COUNTS = { 套餐: 12, 加装包: 9, 营销活动: 6, '港澳台/国际资费': 3 }

const STANDARD_TABLES = [
  {
    tableTitle: '本地通话资费标准',
    tariffTable: {
      tHead: [{ field1: '资费名称' }, { field2: '资费标准' }, { field3: '备注' }],
      tBody: [
        { field1: '本地主叫', field2: '0.15元/分钟', field3: '标准资费' },
        { field1: '本地被叫', field2: '免费', field3: '标准资费' },
        { field1: '国内长途', field2: '0.25元/分钟', field3: '不含港澳台' },
      ],
    },
  },
  {
    tableTitle: '国内漫游及数据业务资费标准',
    tariffTable: {
      tHead: [{ field1: '资费名称' }, { field2: '资费标准' }, { field3: '备注' }],
      tBody: [
        { field1: '国内漫游主叫', field2: '0.29元/分钟', field3: '' },
        { field1: '国内数据流量', field2: '0.29元/MB', field3: '套外流量' },
        { field1: '短信', field2: '0.1元/条', field3: '' },
      ],
    },
  },
]

function makeCards(type, n) {
  const out = []
  for (let i = 1; i <= n; i++) {
    out.push({
      name: `${type}模拟资费${String(i).padStart(2, '0')}`,
      fields: {
        方案编号: `MOCK${type.length}${String(i).padStart(4, '0')}`,
        资费类型: type,
        资费标准: `${(i % 199) + 1}元/月`,
        上线日期: `202${i % 6}年${(i % 12) + 1}月${(i % 28) + 1}日`,
        下线日期: i % 5 === 0 ? `2027年${(i % 12) + 1}月1日` : '',
        适用范围: '全省通用',
      },
    })
  }
  return out
}

const DB = {}
for (const t of TYPES) if (TYPE_COUNTS[t]) DB[t] = makeCards(t, TYPE_COUNTS[t])

/* ---------- 加密信封（模拟 isWX 通道） ---------- */

const envelope = (plain) =>
  JSON.stringify({
    body: Buffer.from(JSON.stringify(plain)).toString('base64'), // 「密文」
  })

const decryptParse = (bodyJson) => JSON.parse(Buffer.from(bodyJson.body, 'base64').toString('utf8'))

/* ---------- HTTP 服务 ---------- */

const server = createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`)

  if (req.method === 'POST' && u.pathname.includes('getTariffListInfo')) {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let type = '套餐'
      let page = 1
      try {
        const body = JSON.parse(raw || '{}') // mock 请求体不加密（scrape 不读请求体）
        type = body.type2Label || TYPES[Number(body.type2 || 1) - 1] || '套餐'
        page = Number(body.page || 1)
      } catch {}
      const all = DB[type] || []
      const limit = 5
      const beans = all.slice((page - 1) * limit, page * limit)
      const plain = {
        returnCode: '0',
        returnMessage: 'success',
        data: { page: { total: all.length, pageNumber: page, pageSize: limit }, beans },
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(envelope(plain))
    })
    return
  }

  if (req.method === 'POST' && u.pathname.includes('getStandardlist')) {
    const plain = {
      returnCode: '0',
      returnMessage: 'success',
      data: { tariffList: STANDARD_TABLES },
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(envelope(plain))
    return
  }

  if (req.method === 'POST' && u.pathname.includes('getType2List')) {
    const plain = {
      returnCode: '0',
      returnMessage: 'success',
      data: TYPES.map((t, i) => ({ type2: String(i + 1), typeName: t })),
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(envelope(plain))
    return
  }

  if (u.pathname === '/tariff.html' || u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(MOCK_PAGE)
    return
  }

  res.writeHead(404)
  res.end('not found')
})

/* ---------- mock 页面（复刻关键 DOM 结构与行为） ---------- */

const MOCK_PAGE = `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>资费公示 mock</title>
<style>
  body { font: 14px/1.6 sans-serif; margin: 0; }
  .header { padding: 10px 16px; border-bottom: 1px solid #eee; display: flex; gap: 16px; align-items: center; }
  .prov-entry { cursor: pointer; color: #0085d0; }
  .prov-list { position: absolute; top: 40px; left: 16px; background: #fff; border: 1px solid #ddd; padding: 6px; z-index: 9; }
  .prov-list span { display: block; padding: 2px 8px; cursor: pointer; }
  .range-tabs { padding: 10px 16px; }
  .range-tab { display: inline-block; padding: 4px 14px; margin-right: 8px; border: 1px solid #ccc; cursor: pointer; }
  .range-tab.active { background: #0085d0; color: #fff; }
  .nav { padding: 8px 16px; display: flex; gap: 24px; align-items: center; border-bottom: 1px solid #f0f0f0; }
  .select-container { position: relative; display: inline-block; }
  .select-label { margin-right: 6px; }
  .select-box { border: 1px solid #ccc; padding: 4px 12px; cursor: pointer; min-width: 120px; display: inline-block; }
  .select-options { position: absolute; top: 100%; left: 0; background: #fff; border: 1px solid #ccc; z-index: 5; }
  .select-item { padding: 4px 12px; cursor: pointer; white-space: nowrap; }
  .select-item:hover { background: #f0f8ff; }
  .hidden { display: none !important; }
  .list { padding: 8px 16px 200px; }
  .tariff-item-container { border: 1px solid #e5e5e5; margin: 10px 0; padding: 14px; max-width: 720px; min-height: 220px; }
  .item-name { font-weight: 600; color: #333; }
  .item-tips-list { margin: 4px 0; }
  .tips-attr { color: #888; display: inline-block; margin-right: 6px; }
  .tips-content { display: inline-block; }
  .loading { padding: 12px 16px; color: #999; }
  .free-cont-box { padding: 12px 16px; }
  .free-cont-title { font-weight: 600; margin-bottom: 6px; }
  .vxe-table--main-wrapper table { border-collapse: collapse; margin-bottom: 18px; }
  .vxe-table--main-wrapper th, .vxe-table--main-wrapper td { border: 1px solid #ccc; padding: 5px 12px; }
</style>
</head>
<body>
<div class="header">
  <b>资费公示</b>
  <span class="prov-entry">请选择省份 ▾</span>
</div>
<div class="prov-list hidden" id="provList">
  <span data-prov="311">河北省</span><span data-prov="531">山东省</span>
</div>
<div class="range-tabs">
  <span class="range-tab" data-tab="all">全网资费</span>
  <span class="range-tab" data-tab="prov">分省资费</span>
</div>
<div class="nav">
  <span class="select-container">
    <span class="select-label">资费类型:</span>
    <span class="select-box" id="typeBox">请选择省</span>
    <span class="select-options hidden" id="typeOptions"></span>
  </span>
</div>
<div class="loading" id="loading" style="display:none">努力加载中...</div>
<div class="list" id="list"></div>
<div id="scroll-flag" style="height:2px"></div>

<script>
/* ---- mock 页状态 ---- */
var state = {
  prov: null, tab: 'all', type: null, page: 0, loading: false, allLoaded: false,
  standard: null, typesReady: false,
}

/* ---- isWX 通道模拟：请求（明文发出）→ 信封响应 → atob「解密」→ JSON.parse ---- */
function api(path, body, cb) {
  var xhr = new XMLHttpRequest()
  xhr.open('POST', path, true)
  xhr.onreadystatechange = function () {
    if (xhr.readyState === 4 && xhr.status === 200) {
      var resp = JSON.parse(xhr.responseText)          // 信封 {body:'密文'}
      // atob 产生 Latin-1 binary string，须按 UTF-8 字节正确解码为文本
      var bin = atob(resp.body)
      var bytes = new Uint8Array(bin.length)
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      var plain = JSON.parse(new TextDecoder('utf-8').decode(bytes)) // ★解密明文必经的 JSON.parse
      setTimeout(function () { cb(plain) }, 120 + Math.random() * 380)
    }
  }
  xhr.setRequestHeader('Content-Type', 'application/json')
  xhr.send(JSON.stringify(body))
}

/* ---- 省选择 ---- */
document.querySelector('.prov-entry').addEventListener('click', function () {
  document.getElementById('provList').classList.remove('hidden')
})
document.querySelectorAll('#provList span').forEach(function (el) {
  el.addEventListener('click', function () {
    if (el.innerText.trim() !== '河北省') return
    state.prov = '311'
    document.getElementById('provList').classList.add('hidden')
    document.querySelector('.prov-entry').innerText = '河北'
    showLoading(true)
    api('/website/nrapigate/nrtariff/new/Tariff/getType2List', { province: '311' }, function (r) {
      state.typesReady = true
      renderTypeOptions(r.data)
      api('/website/nrapigate/nrtariff/new/Tariff/getStandardlist', { province: '311' }, function (r2) {
        state.standard = r2.data            // {tariffList:[{tableTitle,tariffTable}]}
        state.type = '套餐'
        document.getElementById('typeBox').innerText = '套餐'
        loadList(1)
      })
    })
  })
})

/* ---- 页签 ---- */
document.querySelectorAll('.range-tab').forEach(function (el, idx) {
  el.addEventListener('click', function () {
    if (idx !== 1 || !state.prov) return
    document.querySelectorAll('.range-tab').forEach(function (t) { t.classList.remove('active') })
    el.classList.add('active')
    state.tab = 'prov'
    if (state.type) { state.type = '套餐'; document.getElementById('typeBox').innerText = '套餐'; loadList(1) }
  })
})

/* ---- MySelect 复刻：点 box toggle 展开/收起；点 item 选中 ---- */
var box = document.getElementById('typeBox'), optBox = document.getElementById('typeOptions')
var options = []
function renderTypeOptions(list) {
  options = list.map(function (t) { return t.typeName })
  optBox.innerHTML = ''
  options.forEach(function (name) {
    var it = document.createElement('span')
    it.className = 'select-item'
    it.innerText = name
    it.addEventListener('click', function () {
      state.type = name
      box.innerText = name
      optBox.classList.add('hidden')   // 选中即收起
      if (name === '标准资费') { renderStandard() } else { loadList(1) }
    })
    optBox.appendChild(it)
  })
}
box.addEventListener('click', function () { optBox.classList.toggle('hidden') })

/* ---- 懒加载列表 ---- */
function loadList(page) {
  if (state.loading) return
  if (page === 1) { state.allLoaded = false; state.page = 0; document.getElementById('list').innerHTML = '' }
  state.loading = true
  showLoading(true)
  api('/website/nrapigate/nrtariff/new/Tariff/getTariffListInfo',
    { province: '311', isPublic: '1', tariffAttr: '2', type1: '1', type2: String(options.indexOf(state.type) + 1), type2Label: state.type, page: page, limit: 5 },
    function (r) {
      state.page = page
      state.loading = false
      showLoading(false)
      var beans = (r.data && r.data.beans) || []
      var list = document.getElementById('list')
      if (state.type === '标准资费') { list.innerHTML = ''; return }
      beans.forEach(function (b) {
        var c = document.createElement('div')
        c.className = 'tariff-item-container'
        var tips = Object.keys(b.fields || {}).map(function (k) {
          return '<span class="tips-attr">' + k + ':</span><span class="tips-content">' + (b.fields[k] || '-') + '</span>'
        }).join(' ')
        c.innerHTML = '<div class="item-name">' + b.name + '</div><div class="item-tips-list">' + tips + '</div>'
        list.appendChild(c)
      })
      if ((r.data && r.data.page && (page * 5 >= r.data.page.total)) || beans.length === 0) {
        state.allLoaded = true
      }
    })
}
window.addEventListener('scroll', function () {
  var flag = document.getElementById('scroll-flag')
  if (!flag || state.allLoaded || state.type === '标准资费' || state.type === null) return
  var rect = flag.getBoundingClientRect()
  if (rect.top < window.innerHeight + 400 && !state.loading) {
    loadList(state.page + 1)
  }
})

/* ---- 标准资费表格视图（vxe-table 结构复刻） ---- */
function renderStandard() {
  var list = document.getElementById('list')
  list.innerHTML = ''
  if (!state.standard) return
  var wrap = document.createElement('div')
  wrap.className = 'free-cont-box'
  wrap.innerHTML = '<div class="free-cont-title">标准资费</div>' + state.standard.tariffList.map(function (g) {
    var rows = g.tariffTable.tBody.map(function (row) {
      return '<tr>' + g.tariffTable.tHead.map(function (h, i) {
        var key = Object.keys(h)[0]
        return '<td>' + (row[key] || '') + '</td>'
      }).join('') + '</tr>'
    }).join('')
    var head = '<tr>' + g.tariffTable.tHead.map(function (h) {
      return '<th>' + Object.values(h)[0] + '</th>'
    }).join('') + '</tr>'
    return '<div class="vxe-table--main-wrapper"><table><thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>'
  }).join('')
  wrap.appendChild(document.createElement('div'))
  list.appendChild(wrap)
}

function showLoading(on) { document.getElementById('loading').style.display = on ? '' : 'none' }
</script>
</body>
</html>`

server.listen(PORT, () => {
  console.log(`mock 公示页已启动: http://localhost:${PORT}/tariff.html`)
  console.log(`类型数据量: ${JSON.stringify(TYPE_COUNTS)}，标准资费 2 表格组 × 3 行`)
})
