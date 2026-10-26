/**
 * lib/dutyprofile.mjs —— 把宿主 profile 里的「模型线路」抄进值班轮专用 profile
 * ============================================================================
 * 要解决的事（issue #125 / #130，桌面版实测两次）：
 *
 *   值班轮跑在**最小权限 profile**（`bili-duty`）上，它自己只开了
 *   `credentials` / `authorization` / `deepseek-account` —— 宿主 profile 里那些
 *   **自定义 provider 的定义**（`llm-pi-ai` 的 `providers:`、`llm-deepseek` 的
 *   `baseURL:` + `models:`）在这一层**根本没有**。
 *
 *   而 overlay 会把「宿主当前选的模型」写进 `agent-default-model`（那是 2.0.x 为修
 *   `MISSING_CREDENTIAL` 加的，方向是对的）⇒ 该 provider 在值班这棵树里没注册
 *   ⇒ headless **还没发请求就 `NO_ADAPTER` 退出**（1 秒、code=1）。
 *
 *   ⇒ 铺完模板后，把宿主 patch 里「**注册线路 / 定义模型**」的条目原样抄进值班 profile 的
 *     `cordis.patch.yml`。只认「线路声明才有」的键（providers / models / baseURL / apiKeyEnv…），
 *     UI、权限、沙箱、MCP 那些一概不碰；`agent-default-model` 由 overlay 决定，不抄。
 *
 * 纯函数、不碰文件系统（方便 `tools/test-duty-profile.mjs` 直接测）。
 * ============================================================================
 */

/** 「这条 entry 是不是在声明模型线路」——只认线路才有、UI/权限没有的键
 *  ⚠️ 值可能写在同一行（`baseURL: https://…`），也可能另起一块（`models:`）⇒ 两种都要认 */
const PROVIDER_KEY_RE = /^[ \t]+(providers|models|baseURL|base_url|apiBase|apiKeyEnv|api):(?:[ \t]|$)/m

/** 自动追加段的起始标记（重写时从这里截断，保证幂等） */
export const AUTO_SECTION_MARK = '# ==== dsh-bili-scroll: 自动同步的模型线路（每次启动重写，别手改）===='

/**
 * 把一个 cordis patch 文件切成「文件头」+「顶层条目」。
 * 顶层条目 = 列 0 的 `- ` 开头、到下一个列 0 的 `- ` 之前。
 * ⚠️ `insert:` 这种嵌套列表也在**同一层**（它的子条目缩进 4 格，不会被误切成顶层）。
 * @param {string} text
 * @returns {{ header: string, entries: Array<{ id: string, body: string, startLine: number }> }}
 */
export function splitTopLevelEntries(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const header = []
  const entries = []
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^-(?:\s|$)/.test(line)) {
      if (cur) entries.push(cur)
      cur = { lines: [line], startLine: i + 1 }
      continue
    }
    if (cur) cur.lines.push(line)
    else header.push(line)
  }
  if (cur) entries.push(cur)
  for (const e of entries) e.id = entryIdOf(e.lines)
  return { header: header.join('\n'), entries: entries.map(({ id, lines, startLine }) => ({ id, body: lines.join('\n').replace(/\s+$/, ''), startLine })) }
}

/** 从条目里取 id（`- id: x` 单行写法，或 `-` 换行后跟 `  id: x`） */
function entryIdOf(lines) {
  const first = /^-[ \t]+id:[ \t]*['"]?([^\s'"]+)/.exec(lines[0] || '')
  if (first) return first[1]
  for (let i = 1; i < Math.min(lines.length, 6); i++) {
    const m = /^[ \t]+id:[ \t]*['"]?([^\s'"]+)/.exec(lines[i])
    if (m) return m[1]
  }
  return ''
}

/**
 * 摘出所有 `providers:` 映射的**直接子键**（= provider 名）。
 * 例：`config.providers: { route: {...}, command: {...} }` ⇒ { route, command }
 * @param {string} text
 * @returns {Set<string>}
 */
export function providerIdsOf(text) {
  const ids = new Set()
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const head = /^([ \t]+)providers:[ \t]*$/.exec(lines[i])
    if (!head) continue
    const baseIndent = head[1].length
    let childIndent = -1
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (!line.trim() || /^\s*#/.test(line)) continue
      const indent = /^[ \t]*/.exec(line)[0].length
      if (indent <= baseIndent) break
      if (childIndent < 0) childIndent = indent
      if (indent !== childIndent) continue
      const key = /^[ \t]*(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_.@/-]+)):[ \t]*$/.exec(line)
      if (key) ids.add(key[1] || key[2] || key[3])
    }
  }
  return ids
}

/**
 * 判断一条顶层 entry 该不该抄进值班 profile。
 * @param {{ id: string, body: string }} entry
 */
export function isProviderEntry(entry) {
  const id = String(entry?.id || '')
  if (!id && !/^-?[ \t]*insert:/.test(String(entry?.body || ''))) return false   // `- insert:` 也要过下面的键筛选
  if (id === 'agent-default-model') return false          // 由 overlay 决定，别抄
  if (!PROVIDER_KEY_RE.test(String(entry?.body || ''))) return false
  return true
}

/**
 * 值班 profile 里「静态能确认已注册」的 provider 集合。
 * ⚠️ 单线路插件（如 `dsh-llm-deepseek`）由插件自己注册 provider 名，静态看不出来 ——
 *    所以只要抄到了它的条目，就把官方那两个名字算进来（宁可多算，也不少算）。
 * @param {string} copiedText
 * @param {string} [baseText] 模板里本来就有 provider 的文本（`deepseek-account` 等）
 */
export function knownProviders(copiedText, baseText = '') {
  const s = providerIdsOf(copiedText)
  for (const p of providerIdsOf(baseText)) s.add(p)
  if (/dsh-llm-deepseek|llm-deepseek/.test(String(copiedText))) {
    s.add('deepseek-official')
    s.add('deepseek')
  }
  s.add('deepseek-account')      // 模板里 `disabled: false` 的那个账号服务
  return s
}

/** 去掉上一次追加的自动段（幂等用） */
function stripAutoSection(text) {
  const at = String(text ?? '').indexOf(AUTO_SECTION_MARK)
  return at < 0 ? String(text ?? '') : String(text ?? '').slice(0, at)
}

/**
 * 拼出「模板 + 从宿主抄来的线路」的最终 patch 文本。
 * @param {string} templateText 本次刚铺下去的模板内容
 * @param {string} hostText     宿主 profile 的 cordis.patch.yml 内容
 * @param {{ hostProfile?: string }} [opts]
 * @returns {{ text: string, copied: string[], providers: Set<string>, providersFromHost: Set<string> }}
 */
export function buildDutyPatch(templateText, hostText, opts = {}) {
  const hostProfile = String(opts.hostProfile || '宿主')
  const base = stripAutoSection(templateText).replace(/\s+$/, '')
  const { entries } = splitTopLevelEntries(hostText)
  const picked = []
  const seen = new Set()
  for (const e of entries) {
    if (!isProviderEntry(e)) continue
    const key = e.id || e.body
    if (seen.has(key)) continue                     // 同一个 id 只抄一次（后出现的会覆盖前者，抄第一份最稳）
    seen.add(key)
    picked.push(e)
  }
  const copiedText = picked.map((e) => e.body).join('\n\n')
  const header = [
    '',
    AUTO_SECTION_MARK,
    '#',
    '# ⭐ 下面这段是插件每次启动时自动追加的：把宿主 profile（' + hostProfile + '）里',
    '#   「注册模型线路」的条目原样抄到值班轮这一层。',
    '#',
    '#   为什么：值班轮跑在最小权限 profile 上，自己只开了 credentials / authorization /',
    '#   deepseek-account。宿主里那些自定义 provider（llm-pi-ai 的 providers:、',
    '#   llm-deepseek 的 baseURL:/models:）在这一层没注册，而 overlay 又会把「宿主当前选的',
    '#   模型」写进 agent-default-model ⇒ headless 还没发请求就 NO_ADAPTER 秒退（#125 / #130）。',
    '#',
    '#   抄的只有线路声明（providers / models / baseURL / apiKeyEnv…）；UI、权限、沙箱、',
    '#   MCP 一概不碰。agent-default-model 由 overlay 决定，不抄。',
    '#   想关掉：环境变量 BILI_NO_PROVIDER_SYNC=1（这一轮就回到「不抄」，可能 NO_ADAPTER）。',
  ].join('\n')
  const text = picked.length
    ? base + '\n' + header + '\n' + copiedText + '\n'
    : base + '\n'
  return {
    text,
    copied: picked.map((e) => e.id || 'insert'),
    providers: knownProviders(copiedText, base),
    providersFromHost: providerIdsOf(copiedText),
  }
}
