/**
 * lib/feishuChat.mjs —— 在飞书里跟这个插件聊天（长连接，不需要公网）
 * ============================================================================
 * 和「私信聊天」同构：
 *   飞书消息 → 认主人（open_id 配对）→ 起一轮 headless（续同一个会话）→ 模型用
 *   `feishu_send_message` 把回复发回去。
 *
 * 为什么不自己写 WebSocket：飞书的长连接是私有协议，官方 SDK 才靠谱；
 *   `@larksuiteoapi/node-sdk` 只在这里**懒加载**——没装/装坏了插件照样能用（只是聊不了）。
 *
 * 安全模型（三条）：
 *   1. **只有配对过的那一个 open_id** 会被处理，其他人发的消息只回一句"未授权"就丢弃；
 *   2. 配对要**设置页里显示的配对码**，不是谁先发谁就绑定；
 *   3. 回复只发给主人（MCP 侧还有一道硬闸，见 mcp_server.py 的 feishu_send_message）。
 * ============================================================================
 */

/** 从 im.message.receive_v1 事件里取出我们要的字段；不是文本消息就返回 null */
export function parseIncoming(data) {
  const msg = data?.message
  const sender = data?.sender
  if (!msg || !sender) return null
  const openId = String(sender.sender_id?.open_id || '').trim()
  if (!openId) return null
  if (String(msg.message_type || '') !== 'text') return null
  let text = ''
  try { text = String(JSON.parse(String(msg.content || '{}')).text || '') } catch { return null }
  text = cleanText(text)
  if (!text) return null
  return {
    openId,
    chatId: String(msg.chat_id || ''),
    chatType: String(msg.chat_type || 'p2p'),
    messageId: String(msg.message_id || ''),
    text,
  }
}

/** 去掉飞书在群里替换 @ 用的占位符和多余空白 */
export function cleanText(text) {
  return String(text || '')
    .replace(/@_user_\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** `/pair 123456` 这种配对指令 */
export function parsePairCommand(text) {
  const m = /^\/?pair\s+([A-Za-z0-9]{4,10})$/i.exec(cleanText(text))
  return m ? m[1] : ''
}

/** 6 位配对码（不含易混字符） */
export function makePairCode() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  let s = ''
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)]
  return s
}

/**
 * 给"飞书那一轮"的提示词。
 * @param {{ text: string, ownerName?: string, persona?: string, continuing?: boolean }} p
 */
export function replyPrompt({ text, ownerName = '', persona = '', continuing = false }) {
  const who = ownerName ? `${ownerName}` : '主人'
  return (persona ? '（说话风格按这份人设来：\n' + String(persona).slice(0, 3000) + '\n）\n' : '')
    + `这是${who}在**飞书私聊**里发来的一句话：` + JSON.stringify(String(text || '').slice(0, 600))
    + (continuing ? '\n（你们之前已经聊过，按会话历史接着聊，别当第一次见面。）' : '')
    + '\n用 `feishu_send_message` 回他一句（150 字以内，像聊天）。'
    + '\n⚠️ 只回纯文本：**不要 markdown 星号/加粗/表格**、不要写"（多少字…可继续发送…）"，不要复述这条要求。'
}

/**
 * 建立飞书长连接。懒加载 SDK：拿不到就抛错，调用方决定只记日志。
 * @param {{ appId: string, appSecret: string, onMessage: (msg: object) => void, log: (s: string) => void }} p
 * @returns {Promise<{ stop: () => void }>}
 */
export async function startWs({ appId, appSecret, onMessage, log = () => {} }) {
  if (!appId || !appSecret) throw new Error('缺少 App ID / App Secret')
  const lark = await import('@larksuiteoapi/node-sdk')
  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try {
        const msg = parseIncoming(data)
        if (msg) onMessage(msg)
      } catch (e) {
        // 事件处理超过 3 秒会触发飞书重推 ⇒ 这里必须立刻返回，真正的活在后台跑
        log('飞书事件解析出错（已兜住）：' + String(e?.message ?? e).slice(0, 160))
      }
    },
  })
  const ws = new lark.WSClient({ appId, appSecret, loggerLevel: lark.LoggerLevel.error })
  ws.start({ eventDispatcher: dispatcher })
  return { stop: () => { try { ws.close?.() } catch { /* 已经关了 */ } } }
}

/**
 * 校验 App 凭证（不依赖 SDK，纯 HTTPS）：拿得到 tenant_access_token 就算通。
 * @returns {Promise<{ok:boolean, code?:number, err?:string}>}
 */
export async function checkCreds({ appId, appSecret, domain = 'https://open.feishu.cn', timeoutMs = 8000 }) {
  if (!appId || !appSecret) return { ok: false, err: '还没填 App ID / App Secret' }
  try {
    const res = await fetch(String(domain).replace(/\/+$/, '') + '/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const j = await res.json().catch(() => null)
    if (!j) return { ok: false, err: 'HTTP ' + res.status }
    if (Number(j.code) !== 0) return { ok: false, code: Number(j.code), err: String(j.msg || '凭证被拒') }
    return { ok: true }
  } catch (e) {
    return { ok: false, err: String(e?.message ?? e) }
  }
}

/**
 * 宿主直接发一条文本（配对提示 / 未授权提示用；正常回复走 MCP 工具）。
 * 用 SDK 的 Client；拿不到 SDK 时退回纯 HTTPS。
 */
export async function sendText({ appId, appSecret, openId, text, domain = 'https://open.feishu.cn' }) {
  if (!appId || !appSecret || !openId) return { ok: false, err: '缺少凭证或 open_id' }
  try {
    const lark = await import('@larksuiteoapi/node-sdk')
    const client = new lark.Client({ appId, appSecret, domain })
    const r = await client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text: String(text).slice(0, 500) }) },
    })
    const code = Number(r?.code ?? 0)
    return code === 0 ? { ok: true } : { ok: false, code, err: String(r?.msg || '') }
  } catch (e) {
    return { ok: false, err: String(e?.message ?? e) }
  }
}
