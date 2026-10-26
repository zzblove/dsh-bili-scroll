/**
 * lib/feishu.mjs —— 把日报推到飞书（群自定义机器人 webhook）
 * ============================================================================
 * 为什么用 webhook 而不是飞书应用：**推送**只需要一个 URL，不用建应用、不用凭证、
 * 不用长连接；应用那套留给"在飞书里聊天"那条链路（另做）。
 *
 * 边界：
 *   · 只接受 `https://…/open-apis/bot/v2/hook/<token>` 形态的地址（防止把日报发到随便什么服务器）；
 *   · 卡片内容**由宿主拼**，不让模型写 JSON（省 token，也不会被它写坏）；
 *   · 失败只记日志，绝不抛（跑完一轮的收尾里，抛异常会拖垮宿主）。
 * ============================================================================
 */

/** 只认飞书/ Lark 的自定义机器人 webhook */
export function isFeishuWebhook(url) {
  const s = String(url || '').trim()
  if (!/^https:\/\//i.test(s)) return false
  let u
  try { u = new URL(s) } catch { return false }
  const host = u.hostname.toLowerCase()
  const hostOk = host === 'open.feishu.cn' || host.endsWith('.feishu.cn') || host.endsWith('.larksuite.com')
  return hostOk && u.pathname.startsWith('/open-apis/bot/v2/hook/')
}

/**
 * 从日报 markdown 里抠出"挑中的"条目。
 * 只认行首 `### BV…`（章程写死的格式）；`**标题**` 一行里用 ｜ 分隔，容错缺字段。
 * @returns {Array<{bvid,title,up,url,tier,why}>}
 */
export function parseReportPicks(text) {
  const out = []
  for (const block of String(text || '').split(/\n(?=###\s*BV)/)) {
    const head = /^###\s*(BV[0-9A-Za-z]{10})/.exec(block)
    if (!head) continue
    const bvid = head[1]
    const field = (name) => {
      const m = new RegExp('\\*\\*' + name + '\\*\\*\\s*[：:]\\s*([^\\n]*)').exec(block)
      return m ? m[1].trim() : ''
    }
    const titleLine = field('标题')
    const seg = titleLine.split(/\s*[｜|]\s*/)
    const title = (seg[0] || '').replace(/^\*\*|\*\*$/g, '').trim()
    const upFromLine = (() => {
      for (const p of seg.slice(1)) {
        const m = /^\*{0,2}UP\*{0,2}\s*[：:]\s*(.+)$/.exec(p.trim())
        if (m) return m[1].replace(/\*+/g, '').trim()
      }
      return ''
    })()
    const linkInLine = (() => {
      for (const p of seg.slice(1)) {
        const m = /(https?:\/\/\S+)/.exec(p)
        if (m) return m[1]
      }
      return ''
    })()
    const tierM = /\*\*档位\*\*\s*[：:]\s*(值得看|可以看|不值当)/.exec(block)
    const whyM = /\*\*为什么值得\*\*\s*[：:]\s*([\s\S]*?)(?=\n\s*\*\*|$)/.exec(block)
    out.push({
      bvid,
      title: title || bvid,
      up: upFromLine,
      url: linkInLine || 'https://www.bilibili.com/video/' + bvid,
      tier: tierM ? tierM[1] : '',
      why: whyM ? whyM[1].replace(/\s+/g, ' ').trim().slice(0, 220) : '',
    })
  }
  return out
}

const k = (n) => (Number(n) >= 1000 ? (Number(n) / 1000).toFixed(1) + 'k' : String(Number(n) || 0))

/**
 * 拼飞书交互卡片。
 * @param {{ day: string, picks: Array, usage: object|null, detail?: 'full'|'links'|'usage' }} p
 */
export function buildReportCard({ day, picks = [], usage = null, detail = 'full' }) {
  const list = Array.isArray(picks) ? picks : []
  const elements = []
  if (detail !== 'usage') {
    if (!list.length) {
      elements.push({ tag: 'markdown', content: '这一轮没有挑中的条目（或者日报还没写出来）。' })
    } else {
      list.slice(0, 10).forEach((p, i) => {
        const head = `**${i + 1}. ${p.title}**`
        const meta = [p.up ? `UP：${p.up}` : '', p.tier || '', `[看视频](${p.url})`].filter(Boolean).join(' · ')
        const body = [head, meta]
        if (detail === 'full' && p.why) body.push('> ' + p.why)
        elements.push({ tag: 'markdown', content: body.join('\n') })
      })
      if (list.length > 10) elements.push({ tag: 'markdown', content: `…还有 ${list.length - 10} 条，完整日报见本地 out/${day}.md` })
    }
  }
  if (usage && Number(usage.total)) {
    const cache = Number(usage.cacheRead) ? `（缓存命中 ${k(usage.cacheRead)}）` : ''
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: `本轮 token：输入 ${k(usage.input)}${cache} · 输出 ${k(usage.output)}` })
  }
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: list.length ? 'blue' : 'grey',
        title: { tag: 'plain_text', content: `B站鱼塘 · ${day}${list.length ? ` · 挑了 ${list.length} 条` : ''}` },
      },
      elements,
    },
  }
}

/**
 * 发一张卡片。绝不抛：返回 {ok, code, err}。
 * @param {{ url: string, payload: object, timeoutMs?: number }} p
 */
export async function postWebhook({ url, payload, timeoutMs = 10000 }) {
  if (!isFeishuWebhook(url)) return { ok: false, code: 'BAD_URL', err: '不是飞书机器人 webhook 地址' }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text().catch(() => '')
    let json = null
    try { json = JSON.parse(text) } catch { /* 飞书有时回空体 */ }
    const code = json ? (json.code ?? json.StatusCode ?? 0) : (res.ok ? 0 : 'HTTP_' + res.status)
    const ok = res.ok && (code === 0 || code === '0')
    return { ok, code, err: ok ? '' : (json?.msg || text.slice(0, 200) || ('HTTP ' + res.status)) }
  } catch (e) {
    return { ok: false, code: 'NETWORK', err: String(e?.message ?? e) }
  }
}

/** 一步到位：拼卡片 + 发送（宿主在跑完一轮后调用） */
export function sendReport({ url, day, picks, usage, detail = 'full', timeoutMs }) {
  return postWebhook({ url, payload: buildReportCard({ day, picks, usage, detail }), timeoutMs })
}
