// 「本轮 token 用量」回归测试（2.6.0）
//   node tools/test-usage.mjs
// 不联网、只读本地；用临时 DSH_HOME 造会话目录 + 投影缓存。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workspaceDirName, readUsage, findRoundSession, formatUsage } from '../lib/usage.mjs'

const P = join(dirname(fileURLToPath(import.meta.url)), '..') + '/'
const fail = []
let total = 0
const ok = (cond, msg) => { total++; if (!cond) fail.push(msg) }
const roots = []
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'usage-')); roots.push(d); return d }

// ① 会话目录名（DSH 的命名规则）
{
  ok(workspaceDirName('C:\\Users\\a\\.dsh\\bili-duty') === '--C-Users-a-.dsh-bili-duty--', 'win 路径命名不对: ' + workspaceDirName('C:\\Users\\a\\.dsh\\bili-duty'))
  ok(workspaceDirName('/home/a/.dsh/bili-duty') === '--home-a-.dsh-bili-duty--', 'posix 路径命名不对: ' + workspaceDirName('/home/a/.dsh/bili-duty'))
}

// ② 人话格式
{
  const u = { uncachedInput: 80019, cacheRead: 305280, cacheWrite: 0, output: 24160, input: 385299, total: 409459 }
  const f = formatUsage(u)
  ok(f.line.includes('385.3k') && f.line.includes('缓存命中 305.3k') && f.line.includes('24.2k'), '格式化不对: ' + f.line)
  ok(f.short.includes('本轮 token'), '短文本不对: ' + f.short)
  const small = formatUsage({ uncachedInput: 500, cacheRead: 0, cacheWrite: 0, output: 120, input: 500, total: 620 })
  ok(small.line.includes('500') && !small.line.includes('缓存命中'), '小数字/无缓存时格式不对: ' + small.line)
  ok(formatUsage(null).line === '', '没有用量时应返回空')
}

// ③ 读投影缓存（真实 DSH 的字段形状）
{
  const home = mk()
  const sid = 'session-test-1'
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, sid + '.json'), JSON.stringify({
    version: 1,
    record: { identity: {}, rows: { tokenUsage: { ver: 2, seq: 80, val: { totals: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 0 } } } } },
  }), 'utf8')
  const u = readUsage(home, sid)
  ok(u && u.uncachedInput === 1000 && u.cacheRead === 3000 && u.output === 200, '字段没读对: ' + JSON.stringify(u))
  ok(u.input === 4000 && u.total === 4200, '合计不对: ' + JSON.stringify(u))
  ok(readUsage(home, 'session-nope') === null, '读不到时应返回 null')
  ok(readUsage(mk(), sid) === null, '没有投影缓存时应返回 null')
}

// ④ 找这一轮的会话（按 mtime 落在时间窗内、取最新）
{
  const home = mk()
  const cwd = 'C:\\Users\\a\\.dsh\\bili-duty'
  const ws = join(home, 'sessions', workspaceDirName(cwd))
  mkdirSync(ws, { recursive: true })
  const oldSid = 'session-old'
  const newSid = 'session-new'
  mkdirSync(join(ws, oldSid))
  mkdirSync(join(ws, newSid))
  const oldT = new Date(Date.now() - 3600_000)
  utimesSync(join(ws, oldSid), oldT, oldT)
  const since = Date.now() - 600_000
  ok(findRoundSession(home, cwd, since) === newSid, '没挑出时间窗内的最新会话')
  utimesSync(join(ws, newSid), oldT, oldT)
  ok(findRoundSession(home, cwd, since) === '', '窗口内没有会话时应返回空')
  ok(findRoundSession(mk(), cwd, since) === '', '没有会话目录时应返回空（不抛）')
}

// ⑤ 接线：插件真的记了、也真的能私信
{
  const idx = readFileSync(P + 'index.js', 'utf8')
  const cli = readFileSync(P + 'client.js', 'utf8')
  ok(/from '\.\/lib\/usage\.mjs'/.test(idx), 'index.js 没 import usage.mjs')
  ok(idx.includes('collectRoundUsage('), '轮结束没有收集用量')
  ok(/child\.on\('exit'[\s\S]{0,1500}collectRoundUsage/.test(idx), 'exit 回调里没调用 collectRoundUsage')
  ok(idx.includes('dmUsageReport'), '没有私信上报')
  ok(idx.includes('dmUsage: true') && idx.includes('dmUsage: z.boolean()'), '配置里没有 dmUsage')
  ok(idx.includes("if ('dmUsage' in p)"), 'persistCfg 没处理 dmUsage')
  ok(idx.includes('usage: (() =>'), 'status 里没有 usage')
  ok(idx.includes("call('bili_send_message', { receiver_uid: uid, text })"), '私信上报没走 bili_send_message 并锁死 uid')
  ok(cli.includes('本轮 token 用量'), '设置页没有用量区块')
  ok(cli.includes('把每轮 token 用量私信给我'), '设置页没有用量私信开关')
}

for (const d of roots) { try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }

if (fail.length) {
  console.error(`❌ token 用量自检失败（${fail.length}/${total}）：`)
  for (const f of fail) console.error('  - ' + f)
  process.exit(1)
}
console.log(`✅ token 用量通过（${total} 条断言）`)
