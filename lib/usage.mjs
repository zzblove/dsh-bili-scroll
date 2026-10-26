/**
 * lib/usage.mjs —— 从 DSH 自己的会话投影里读「这一轮花了多少 token」
 * ============================================================================
 * 为什么不用估算：DSH 会把每个会话的用量写进**投影缓存**
 *   <DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json
 *   → record.rows.tokenUsage.val.totals = {
 *        uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
 * 这是 DSH 自己算的账，比"字数÷1.5"精确得多。
 *
 * 麻烦的地方：值班轮**不复用会话**（每轮新开一个），所以轮结束时要自己找出来
 * 是哪个 session —— 做法：看会话目录的 mtime 落在这一轮的时间窗内（和私信那条
 * `discoverDmSession` 一个思路），再读它的投影缓存。
 *
 * 读不到不算错（老版本 DSH 没有投影缓存、或会话还没落盘）⇒ 返回 null，界面显示"未知"。
 * ============================================================================
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** DSH 的工作区会话目录名：`--C-Users-xxx-.dsh-bili-duty--`（盘符冒号去掉、分隔符换横线） */
export function workspaceDirName(cwd) {
  const s = String(cwd || '').replace(/[:\\/]+/g, '-').replace(/^-+|-+$/g, '')
  return `--${s}--`
}

/** 一轮的 token 账 */
export function readUsage(dshHome, sessionId) {
  const p = join(dshHome, 'storages', 'session_projcache', 'sessions', sessionId + '.json')
  let j
  try { j = JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
  const totals = j?.record?.rows?.tokenUsage?.val?.totals
  if (!totals || typeof totals !== 'object') return null
  const num = (v) => Number(v) || 0
  const uncachedInput = num(totals.uncachedInputTokens)
  const cacheRead = num(totals.cacheReadTokens)
  const cacheWrite = num(totals.cacheWriteTokens)
  const output = num(totals.outputTokens)
  const input = uncachedInput + cacheRead + cacheWrite
  if (!input && !output) return null
  return { sessionId, uncachedInput, cacheRead, cacheWrite, output, input, total: input + output }
}

/**
 * 找这一轮开出来的会话（mtime 落在 [sinceMs-5s, now] 内、最新的那个）。
 * @returns {string} sessionId，找不到返回空串
 */
export function findRoundSession(dshHome, cwd, sinceMs) {
  const dir = join(dshHome, 'sessions', workspaceDirName(cwd))
  let ents = []
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return '' }
  let best = ''
  let bestAt = 0
  for (const e of ents) {
    if (!e.isDirectory() || !e.name.startsWith('session-')) continue
    let m = 0
    try { m = statSync(join(dir, e.name)).mtimeMs } catch { continue }
    if (m < sinceMs - 5000) continue
    if (m > bestAt) { bestAt = m; best = e.name }
  }
  return best
}

/** 把用量写成人话 + 一行短文本（给界面和私信用） */
export function formatUsage(u) {
  if (!u) return { line: '', short: '' }
  const k = (n) => (Number(n) >= 1000 ? (Number(n) / 1000).toFixed(1) + 'k' : String(Number(n) || 0))
  const cache = u.cacheRead ? `（缓存命中 ${k(u.cacheRead)}）` : ''
  const line = `输入 ${k(u.input)}${cache} · 输出 ${k(u.output)} · 合计 ${k(u.total)} tokens`
  const short = `本轮 token：输入 ${k(u.input)}${cache}，输出 ${k(u.output)}`
  return { line, short }
}

/** 估算金额（可选）：只做"量级参考"，按传入的单价（元/百万 token）算 */
export function estimateCost(u, { inputPerM = 0, outputPerM = 0 } = {}) {
  if (!u || (!inputPerM && !outputPerM)) return null
  const cachedShare = u.cacheRead && u.input ? u.cacheRead / u.input : 0
  // 缓存命中的部分按 1/10 价估算（DeepSeek 的缓存价大致是这个量级）
  const effectiveInput = u.input * (1 - cachedShare * 0.9)
  const cost = (effectiveInput / 1e6) * inputPerM + (u.output / 1e6) * outputPerM
  return Number.isFinite(cost) ? cost : null
}