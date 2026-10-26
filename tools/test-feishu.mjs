// 飞书日报推送（2.7.0）回归测试
//   node tools/test-feishu.mjs
// 不联网：用 fetch 桩模拟飞书响应（真实地址只用来过地址校验）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isFeishuWebhook, parseReportPicks, buildReportCard, postWebhook, sendReport } from '../lib/feishu.mjs'

const P = join(dirname(fileURLToPath(import.meta.url)), '..') + '/'
const fail = []
let total = 0
const ok = (cond, msg) => { total++; if (!cond) fail.push(msg) }
const FEISHU_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/fake-token'
const withFetch = async (impl, fn) => {
  const saved = globalThis.fetch
  globalThis.fetch = impl
  try { return await fn() } finally { globalThis.fetch = saved }
}

// ① 地址校验：只认飞书 / Lark 的自定义机器人 webhook（防止日报被发到随便什么服务器）
{
  ok(isFeishuWebhook(FEISHU_URL), '标准飞书地址被拒')
  ok(isFeishuWebhook('https://open.larksuite.com/open-apis/bot/v2/hook/abc'), 'Lark 地址被拒')
  ok(!isFeishuWebhook('http://open.feishu.cn/open-apis/bot/v2/hook/x'), 'http 不该通过')
  ok(!isFeishuWebhook('https://evil.example.com/open-apis/bot/v2/hook/x'), '第三方域名不该通过')
  ok(!isFeishuWebhook('https://feishu.cn.evil.com/open-apis/bot/v2/hook/x'), '后缀伪装不该通过')
  ok(!isFeishuWebhook('https://open.feishu.cn/other/path'), '路径不对不该通过')
  ok(!isFeishuWebhook(''), '空地址不该通过')
}

// ② 日报解析（按章程写死的 `### BV号` 格式）
{
  const md = [
    '# 刷B站日报 2026-10-26',
    '',
    '### BV1pGnn67EbB',
    '**标题**：带着100万，我们见了成人网红... ｜ **UP**：影视飓风 ｜ **链接**：https://www.bilibili.com/video/BV1pGnn67EbB',
    '**播放**：598.5万 ｜ **时长**：44:42 ｜ **档位**：值得看',
    '**为什么值得**：把产业链拆得很清楚。',
    '**我的一句话**：最刺的是代聊那段。',
    '',
    '### BV1XynB6EEiM',
    '**标题**：【何同学】能折！但代价呢？ ｜ **UP**：老师好我叫何同学',
    '**档位**：可以看',
  ].join('\n')
  const picks = parseReportPicks(md)
  ok(picks.length === 2, '应解析出 2 条，实际 ' + picks.length)
  const a = picks.find((p) => p.bvid === 'BV1pGnn67EbB')
  ok(a && a.title.startsWith('带着100万'), '标题没解析出来：' + JSON.stringify(a))
  ok(a && a.up === '影视飓风', 'UP 没解析出来：' + JSON.stringify(a && a.up))
  ok(a && a.url === 'https://www.bilibili.com/video/BV1pGnn67EbB', '链接没解析出来：' + JSON.stringify(a && a.url))
  ok(a && a.tier === '值得看' && a.why.includes('产业链'), '档位/理由没解析出来')
  const b = picks.find((p) => p.bvid === 'BV1XynB6EEiM')
  ok(b && b.url === 'https://www.bilibili.com/video/BV1XynB6EEiM', '缺链接时应回退成视频地址：' + JSON.stringify(b && b.url))
  ok(parseReportPicks('').length === 0, '空文本不该解析出条目')
  ok(parseReportPicks('### 不是BV号\n正文').length === 0, '非 BV 标题不该算条目')
}

// ③ 卡片：三种档位 + 空列表 + 超长截断
{
  const picks = [
    { bvid: 'BV1a', title: '标题一', up: 'UP一', url: 'https://www.bilibili.com/video/BV1a', tier: '值得看', why: '理由一' },
    { bvid: 'BV1b', title: '标题二', up: '', url: 'https://www.bilibili.com/video/BV1b', tier: '', why: '理由二' },
  ]
  const usage = { input: 385299, cacheRead: 305280, output: 24160, total: 409459 }

  const full = buildReportCard({ day: '2026-10-26', picks, usage, detail: 'full' })
  ok(full.msg_type === 'interactive' && full.card.header.template === 'blue', '卡片基本结构不对')
  ok(full.card.header.title.content.includes('挑了 2 条'), '标题没带条数：' + full.card.header.title.content)
  const fullText = JSON.stringify(full)
  ok(fullText.includes('理由一') && fullText.includes('理由二'), 'full 档应带理由')
  ok(fullText.includes('385.3k') && fullText.includes('24.2k'), '用量没进卡片')
  ok(fullText.includes('缓存命中 305.3k'), '缓存命中没写')

  const links = buildReportCard({ day: '2026-10-26', picks, usage, detail: 'links' })
  ok(!JSON.stringify(links).includes('理由一'), 'links 档不该带理由')
  ok(JSON.stringify(links).includes('标题一'), 'links 档应带标题')

  const onlyUsage = buildReportCard({ day: '2026-10-26', picks, usage, detail: 'usage' })
  ok(!JSON.stringify(onlyUsage).includes('标题一'), 'usage 档不该带条目')
  ok(JSON.stringify(onlyUsage).includes('本轮 token'), 'usage 档应带用量')

  const empty = buildReportCard({ day: '2026-10-26', picks: [], usage: null })
  ok(empty.card.header.template === 'grey', '空列表应用灰色表头')
  ok(JSON.stringify(empty).includes('没有挑中的条目'), '空列表该有说明')

  const many = buildReportCard({ day: '2026-10-26', picks: Array.from({ length: 13 }, (_, i) => ({ bvid: 'BV' + i, title: 't' + i, url: 'u' + i })) })
  ok(JSON.stringify(many).includes('还有 3 条'), '超过 10 条应提示剩余数量')
}

// ④ 发送：成功 / 业务错误 / 网络错误 / 地址拦截
{
  const payload = buildReportCard({ day: '2026-10-26', picks: [], usage: null })

  const blocked = await postWebhook({ url: 'http://127.0.0.1:9/open-apis/bot/v2/hook/x', payload })
  ok(!blocked.ok && blocked.code === 'BAD_URL', '非飞书地址应被拦下（不真发请求）')

  const good = await withFetch(
    async () => new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 }),
    () => postWebhook({ url: FEISHU_URL, payload }),
  )
  ok(good.ok && good.code === 0, 'code=0 应判成功：' + JSON.stringify(good))

  const biz = await withFetch(
    async () => new Response(JSON.stringify({ code: 19021, msg: 'sign match fail' }), { status: 200 }),
    () => postWebhook({ url: FEISHU_URL, payload }),
  )
  ok(!biz.ok && String(biz.err).includes('sign'), '业务错误没被判失败：' + JSON.stringify(biz))

  const net = await withFetch(
    async () => { throw new Error('ECONNREFUSED') },
    () => postWebhook({ url: FEISHU_URL, payload }),
  )
  ok(!net.ok && net.code === 'NETWORK', '网络错误没被兜住：' + JSON.stringify(net))

  const http500 = await withFetch(
    async () => new Response('boom', { status: 500 }),
    () => postWebhook({ url: FEISHU_URL, payload }),
  )
  ok(!http500.ok, 'HTTP 500 应判失败')
}

// ⑤ sendReport：端到端拼装（payload 形状 + 只发一次）
{
  let calls = 0
  let captured = ''
  const r = await withFetch(
    async (u, opts) => { calls++; captured = String(opts?.body || ''); return new Response(JSON.stringify({ code: 0 }), { status: 200 }) },
    () => sendReport({
      url: FEISHU_URL,
      day: '2026-10-26',
      picks: [{ bvid: 'BV1a', title: '标题甲', up: '某UP', url: 'https://www.bilibili.com/video/BV1a', tier: '值得看', why: '理由甲' }],
      usage: { input: 1000, cacheRead: 0, output: 200, total: 1200 },
      detail: 'full',
    }),
  )
  ok(r.ok && calls === 1, 'sendReport 应只发一次且成功：calls=' + calls)
  const body = JSON.parse(captured)
  ok(body.msg_type === 'interactive', 'payload msg_type 不对')
  ok(body.card.header.title.content.includes('2026-10-26'), 'payload 里没有日期')
  ok(JSON.stringify(body).includes('标题甲') && JSON.stringify(body).includes('理由甲'), 'payload 里没有条目内容')
  ok(JSON.stringify(body).includes('1.0k'), 'payload 里没有用量')
}

// ⑥ 接线
{
  const idx = readFileSync(P + 'index.js', 'utf8')
  const cli = readFileSync(P + 'client.js', 'utf8')
  ok(/from '\.\/lib\/feishu\.mjs'/.test(idx), 'index.js 没 import feishu.mjs')
  ok(idx.includes('feishuOn: z.boolean()') && idx.includes('feishuWebhook: z.string()'), 'Config 里没有飞书字段')
  ok(idx.includes("if ('feishuOn' in p)") && idx.includes("if ('feishuWebhook' in p)"), 'persistCfg 没处理飞书字段')
  ok(idx.includes('const pushFeishuReport'), '没有推送函数')
  ok(/collectRoundUsage\([^)]*\)[\s\S]{0,240}pushFeishuReport/.test(idx), '跑完一轮后没接着推飞书')
  ok(idx.includes('/api/bili-duty/feishu/test'), '缺测试推送接口')
  ok(idx.includes('feishu: (() =>'), 'status 里没有 feishu')
  ok(cli.includes('飞书日报'), '设置页没有飞书区块')
  ok(cli.includes('发一条测试'), '设置页没有测试按钮')
}

if (fail.length) {
  console.error(`❌ 飞书日报自检失败（${fail.length}/${total}）：`)
  for (const f of fail) console.error('  - ' + f)
  process.exit(1)
}
console.log(`✅ 飞书日报通过（${total} 条断言）`)
