// 飞书聊天（2.8.0）回归测试
//   node tools/test-feishu-chat.mjs
// 不联网：需要发请求的地方都用 fetch 桩；WSClient 只做"没凭证要抛错"的检查。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseIncoming, cleanText, parsePairCommand, makePairCode, replyPrompt, checkCreds, sendText,
} from '../lib/feishuChat.mjs'

const P = join(dirname(fileURLToPath(import.meta.url)), '..') + '/'
const fail = []
let total = 0
const ok = (cond, msg) => { total++; if (!cond) fail.push(msg) }
const withFetch = async (impl, fn) => {
  const saved = globalThis.fetch
  globalThis.fetch = impl
  try { return await fn() } finally { globalThis.fetch = saved }
}

// ① 事件解析：只认文本、只认带 open_id 的发送者
{
  const evt = {
    sender: { sender_id: { open_id: 'ou_abc', union_id: 'on_x', user_id: 'u1' } },
    message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '  你好呀  ' }) },
  }
  const m = parseIncoming(evt)
  ok(m && m.openId === 'ou_abc' && m.text === '你好呀', '文本事件没解析对：' + JSON.stringify(m))
  ok(m.chatId === 'oc_1' && m.chatType === 'p2p' && m.messageId === 'om_1', 'chat 字段没解析对')
  ok(parseIncoming({ sender: { sender_id: { open_id: 'ou_abc' } }, message: { message_type: 'image', content: '{}' } }) === null, '非文本消息应忽略')
  ok(parseIncoming({ message: { message_type: 'text', content: '{"text":"x"}' } }) === null, '没有发送者应忽略')
  ok(parseIncoming({ sender: { sender_id: { open_id: 'ou_a' } }, message: { message_type: 'text', content: 'not-json' } }) === null, '坏 content 应忽略')
  ok(parseIncoming({ sender: { sender_id: { open_id: 'ou_a' } }, message: { message_type: 'text', content: '{"text":"   "}' } }) === null, '空文本应忽略')
}

// ② @占位符清洗 + 配对指令
{
  ok(cleanText('@_user_1 帮我看下这个 @_user_2 视频') === '帮我看下这个 视频', '清洗 @ 占位符不对：' + cleanText('@_user_1 帮我看下这个 @_user_2 视频'))
  ok(parsePairCommand('/pair ABC123') === 'ABC123', '/pair 没解析出来')
  ok(parsePairCommand('pair abc123') === 'abc123', '无斜杠的 pair 没解析出来')
  ok(parsePairCommand('  /PAIR  A1B2C3  ') === 'A1B2C3', '大小写/空白没容错')
  ok(parsePairCommand('你好') === '', '普通消息不该当配对指令')
  ok(parsePairCommand('/pair') === '', '缺码不该通过')
}

// ③ 配对码：6 位、无易混字符、随机
{
  const codes = new Set()
  for (let i = 0; i < 50; i++) {
    const c = makePairCode()
    codes.add(c)
    ok(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/.test(c), '配对码字符集不对：' + c)
  }
  ok(codes.size > 40, '配对码不够随机：' + codes.size)
}

// ④ 提示词：带发言人/指令/禁 markdown；人设截断
{
  const p = replyPrompt({ text: '今天好累', persona: 'x'.repeat(5000), continuing: true })
  ok(p.includes('今天好累'), '提示词里没有原话')
  ok(p.includes('feishu_send_message'), '没告诉它用哪只工具回复')
  ok(p.includes('不要 markdown'), '没写禁 markdown')
  ok(p.includes('别当第一次见面'), '续会话提示没写')
  ok(p.length < 5000, '人设没有截断（长度 ' + p.length + '）')
  const first = replyPrompt({ text: 'hi' })
  ok(!first.includes('别当第一次见面'), '首轮不该说"别当第一次见面"')
}

// ⑤ 凭证检查（fetch 桩）
{
  ok((await checkCreds({ appId: '', appSecret: '' })).ok === false, '空凭证应判失败')

  const good = await withFetch(
    async () => new Response(JSON.stringify({ code: 0, tenant_access_token: 't-1' }), { status: 200 }),
    () => checkCreds({ appId: 'cli_x', appSecret: 's' }),
  )
  ok(good.ok, 'code=0 应判通：' + JSON.stringify(good))

  const bad = await withFetch(
    async () => new Response(JSON.stringify({ code: 10003, msg: 'invalid param' }), { status: 200 }),
    () => checkCreds({ appId: 'cli_x', appSecret: 'bad' }),
  )
  ok(!bad.ok && bad.code === 10003, '业务错误没被判失败：' + JSON.stringify(bad))

  const net = await withFetch(
    async () => { throw new Error('ECONNREFUSED') },
    () => checkCreds({ appId: 'cli_x', appSecret: 's' }),
  )
  ok(!net.ok && /ECONNREFUSED/.test(String(net.err)), '网络错误没被兜住')

  const noCred = await sendText({ appId: '', appSecret: '', openId: 'ou_x', text: 'hi' })
  ok(!noCred.ok, '缺凭证时 sendText 应失败而不是抛')
}

// ⑥ MCP 侧硬闸：只能发给配对过的主人
{
  const py = readFileSync(P + 'vendor/bilibili-mcp/mcp_server.py', 'utf8')
  ok(py.includes('def feishu_send_message'), 'MCP 里没有 feishu_send_message')
  ok(py.includes('FEISHU_OWNER_OPEN_ID'), 'MCP 没读主人 open_id')
  ok(py.includes('飞书回复只能发给配对过的主人'), 'MCP 没有硬闸（允许发给别人）')
  ok(py.includes('tenant_access_token'), 'MCP 没走 tenant token 换发消息')
}

// ⑦ 插件接线：通道隔离、凭证只在飞书轮下发、路由与界面
{
  const idx = readFileSync(P + 'index.js', 'utf8')
  const cli = readFileSync(P + 'client.js', 'utf8')
  ok(idx.includes("let roundChannel = 'duty'"), '没有 roundChannel')
  ok(/roundChannel === 'feishu'\) list\.push\('feishu_send_message'\)/.test(idx), '白名单没按通道下发 feishu_send_message')
  ok(/roundChannel === 'feishu'[\s\S]{0,200}FEISHU_APP_ID/.test(idx), 'overlay 没在飞书轮下发应用凭证')
  ok(idx.includes('roundChannel = \'feishu\'') && idx.includes("finally { roundChannel = 'duty' }"), 'roundChannel 没在起轮前后正确切换/复位')
  ok(idx.includes('/api/bili-duty/feishu/chat'), '缺 GET /feishu/chat')
  ok(idx.includes('/feishu/chat/check') && idx.includes('/feishu/chat/pair/reset') && idx.includes('/feishu/chat/session/reset'), '缺三个操作接口')
  ok(idx.includes('startWs('), '没有建立长连接')
  ok(idx.includes('feishuChat: (() =>'), 'status 里没有 feishuChat')
  ok(idx.includes('reloadFeishuChat()'), '设置保存后没重建连接')
  ok(idx.includes("stopFeishuChat()") && idx.includes('收飞书长连接'), '卸载时没关长连接')
  ok(cli.includes('飞书聊天'), '设置页没有飞书聊天区块')
  ok(cli.includes('配对码'), '设置页没显示配对码')
  ok(cli.includes('检查凭证') && cli.includes('重新配对') && cli.includes('重置会话'), '设置页缺按钮')
  const pkg = JSON.parse(readFileSync(P + 'package.json', 'utf8'))
  ok(/@larksuiteoapi\/node-sdk/.test(JSON.stringify(pkg.dependencies || {})), 'package.json 没声明飞书 SDK 依赖')
}

if (fail.length) {
  console.error(`❌ 飞书聊天自检失败（${fail.length}/${total}）：`)
  for (const f of fail) console.error('  - ' + f)
  process.exit(1)
}
console.log(`✅ 飞书聊天通过（${total} 条断言）`)
