/**
 * lib/memory.mjs —— 把「Markdown 项目共享记忆」（scripts/mem.py + memory/）接进刷B站
 * ============================================================================
 * 为什么单独一个模块：值班轮跑在**最小权限 profile** 上（没有文件系统、没有命令），
 * 所以它自己既跑不了 `python scripts/mem.py search`，也写不了 memory/ 里的 markdown。
 * ⇒ **读**由宿主在起轮之前做好、内联进提示词；**写**通过 MCP 里那几只看门工具代劳。
 *
 * 约定（照 user 那套 memory kit 的协议，不自己发明格式）：
 *   · 记忆项目根目录 = 一个包含 `scripts/mem.py` 和 `memory/` 的目录；
 *   · 检索一律 `--mode local`（纯本地关键词/BM25，不读 API key、不联网、不花钱）；
 *   · 写入一律走 `mem.py add`（它自己带写锁与去重），写完 `reindex --local`；
 *   · 类型只有 fact / decision / howto / correction 四种。
 *
 * 纯函数 + 薄 IO，方便 tools/test-memory.mjs 直接测。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 允许模型写的记忆类型（mem.py add 的 --type 取值） */
export const MEM_TYPES = ['fact', 'decision', 'howto', 'correction']
/** 这几只工具只在「这一轮真的配了记忆目录」时才下发给模型 */
export const MEM_TOOLS = ['bili_mem_search', 'bili_mem_show', 'bili_mem_add']

/**
 * 找到一个可用的记忆项目根目录。
 * 优先用设置里填的；没填就退到工作区（工作区里恰好有 memory kit 时也能直接用）。
 * @param {{ memoryDir?: string, workspace?: string }} opts
 * @returns {{ root: string, from: string, ok: boolean, reason: string }}
 */
export function resolveMemoryRoot(opts = {}) {
  const memoryDir = String(opts.memoryDir || '').trim()
  const workspace = String(opts.workspace || '').trim()
  const cands = []
  if (memoryDir) cands.push({ dir: memoryDir, from: '设置里的记忆目录' })
  else if (workspace) cands.push({ dir: workspace, from: '工作区' })
  if (!cands.length) {
    return { root: '', from: '', ok: false, reason: '没填记忆目录（也没有工作区可退）⇒ 这一轮不带记忆' }
  }
  const bad = []
  for (const c of cands) {
    const memPy = join(c.dir, 'scripts', 'mem.py')
    const memDir = join(c.dir, 'memory')
    if (existsSync(memPy) && existsSync(memDir)) return { root: c.dir, from: c.from, ok: true, reason: '' }
    if (!existsSync(memPy)) bad.push(`${c.from} 里没有 scripts/mem.py`)
    else bad.push(`${c.from} 里没有 memory/ 目录`)
  }
  return { root: '', from: cands[0].from, ok: false, reason: bad.join('；') }
}

/** 检索词：把关注关键词拼起来（空关键词 ⇒ 空串，调用方自己决定跳不跳） */
export function searchQueryOf(keywords, extra = '') {
  const list = (Array.isArray(keywords) ? keywords : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
  if (extra) list.push(String(extra).trim())
  return list.join(' ').replace(/\s+/g, ' ').slice(0, 200)
}

/** 截断：按行切，别把一条候选劈成两半；超了就补一句说明 */
export function clipText(text, max = 2000) {
  const s = String(text ?? '').replace(/\r\n/g, '\n').trimEnd()
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const at = cut.lastIndexOf('\n')
  const body = at > max * 0.6 ? cut.slice(0, at) : cut
  return body + `\n…（还有 ${s.length - body.length} 字没显示；要看全文用 bili_mem_show）`
}

/**
 * 拼「记忆」那一段提示词。检索结果为空时返回空串（别拿一句"没有记忆"占预算）。
 * @param {{ query: string, output: string, root: string, from: string }} p
 */
export function buildMemoBlock(p) {
  const out = String(p?.output || '').trim()
  const query = String(p?.query || '').trim()
  if (!out || !query) return ''
  // 工具明确说"无相关记忆"就不注入 —— 免得模型把空结果当成"确实没这回事"去编
  if (/无相关记忆|（判重表还不存在）|没有相关记忆/.test(out)) return ''
  return [
    '',
    '## 你的长期记忆（宿主刚检索过，**先看这里再挑**）',
    '',
    `检索词：\`${query}\`（` + String(p.from || '记忆目录') + '，本地检索、不联网）',
    '',
    '```text',
    clipText(out, 2000),
    '```',
    '',
    '⭐ 用法：摘要只能用来筛，**引用数字 / 路径 / 结论前必须回看原文** ——',
    '用 `bili_mem_show(path=…, grep=…或 lines=…)`；要按别的词再找一遍就用 `bili_mem_search(query=…)`。',
    '⚠️ 记忆和本轮看到的内容冲突时，**以本轮看到的内容为准**；发现记忆过时了，用 `bili_mem_add(type="correction", …)` 更正，不要默默无视。',
  ].join('\n')
}

/** 拼 `mem.py search` 的参数（纯函数，测试直接用） */
export function searchArgs(query, { k = 5, maxChars = 2000 } = {}) {
  return ['search', String(query), '--mode', 'local', '-k', String(k), '--max-chars', String(maxChars)]
}

/** 拼 `mem.py show` 的参数 */
export function showArgs(path, { grep = '', lines = '', maxChars = 8000 } = {}) {
  const args = ['show', String(path)]
  if (grep) args.push('--grep', String(grep), '-C', '2')
  else if (lines) args.push('--lines', String(lines))
  args.push('--max-chars', String(maxChars))
  return args
}

/** 拼 `mem.py add` 的参数（正文走临时文件，避免超长命令行） */
export function addArgs({ type, title, summary, bodyFile, scope = '', source = '' }) {
  const args = ['add', '--type', String(type), '--title', String(title), '--summary', String(summary), '--body-file', String(bodyFile)]
  if (scope) args.push('--scope', String(scope))
  if (source) args.push('--source', String(source))
  return args
}

/**
 * 跑 mem.py 一次（带超时；绝不抛）。
 * @returns {Promise<{ ok: boolean, out: string, err: string, code: number }>}
 */
export function runMem({ python = 'python', root, args, timeoutMs = 12000, maxOut = 200000 }) {
  return new Promise((resolve) => {
    let done = false
    let out = ''
    let err = ''
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r) } }
    let child
    try {
      child = spawn(String(python || 'python'), [join(root, 'scripts', 'mem.py'), ...args], {
        cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      return resolve({ ok: false, out: '', err: String(e?.message ?? e), code: -1 })
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已经没了 */ }
      finish({ ok: false, out, err: '超时（' + timeoutMs + 'ms）', code: -1 })
    }, timeoutMs)
    child.stdout.setEncoding?.('utf8')
    child.stderr.setEncoding?.('utf8')
    child.stdout.on('data', (c) => { if (out.length < maxOut) out += c })
    child.stderr.on('data', (c) => { err = (err + c).slice(-4000) })
    child.on('error', (e) => finish({ ok: false, out, err: String(e?.message ?? e), code: -1 }))
    child.on('close', (code) => finish({ ok: code === 0, out, err, code: code ?? -1 }))
  })
}

/** 检索记忆（宿主侧，起轮之前跑） */
export async function searchMemory({ python, root, query, k = 5, timeoutMs = 8000 }) {
  if (!root || !query) return { ok: false, out: '', err: '没有记忆目录或检索词' }
  return runMem({ python, root, args: searchArgs(query, { k }), timeoutMs })
}

/** 追加一条记忆，然后异步 reindex（失败不影响已落盘的那条） */
export async function addMemory({ python, root, type, title, summary, body, scope = '', source = '', timeoutMs = 20000 }) {
  if (!root) return { ok: false, out: '', err: '没有记忆目录' }
  const t = String(type || '').trim()
  if (!MEM_TYPES.includes(t)) return { ok: false, out: '', err: '类型只能是 ' + MEM_TYPES.join(' / ') }
  const tmp = join(root, '.bili-mem-body-' + process.pid + '-' + Date.now() + '.md')
  try {
    writeFileSync(tmp, String(body || '').trim() + '\n', 'utf8')
    const r = await runMem({ python, root, args: addArgs({ type: t, title, summary, bodyFile: tmp, scope, source }), timeoutMs })
    return r
  } finally {
    try { rmSync(tmp, { force: true }) } catch { /* 删不掉也无所谓 */ }
  }
}

/** 轻量体检：只回答"这个目录像不像记忆项目" */
export function memoryHealth(opts = {}) {
  const r = resolveMemoryRoot(opts)
  if (!r.ok) return { ...r, files: 0 }
  let files = 0
  try {
    const idx = readFileSync(join(r.root, 'memory', 'index.md'), 'utf8')
    files = idx.split(/\r?\n/).filter((l) => l.trim().startsWith('- ')).length
  } catch { /* 没有 index.md 就当 0 条 */ }
  return { ...r, files }
}
