// 值班 profile「宿主线路同步」（issue #125 / #130）回归测试
//   node tools/test-duty-profile.mjs
// 纯函数直测 + 接线静态断言，不联网、不碰真家目录。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  splitTopLevelEntries, providerIdsOf, isProviderEntry, knownProviders, buildDutyPatch, AUTO_SECTION_MARK,
} from '../lib/dutyprofile.mjs'

const P = join(dirname(fileURLToPath(import.meta.url)), '..') + '/'
const fail = []
let total = 0
const ok = (cond, msg) => { total++; if (!cond) fail.push(msg) }

const TEMPLATE = `# 值班轮专用 profile
- id: credentials
  disabled: false
- id: agent-default-model
  config:
    provider: deepseek-account
    model: deepseek-flash
- id: tool-fs
  disabled: true
`

// 形状照抄真实 Desktop profile 的 patch（含一个带 Authorization 的 insert，必须不被抄走）
const HOST = `# Your patch layer for this dsh profile, applied after every bundle layer:
- insert:
    - id: firecrawl-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: streamable-http
        url: https://mcp.firecrawl.dev/v2/mcp-oauth
        headers:
          Authorization: 'Bearer fc-0123456789abcdef'
- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    baseURL: https://example.invalid/v1
    models:
      - id: deepseek-v4.1-flash
        name: DeepSeek-V4.1-Flash
- id: agent-default-model
  config:
    provider: command
    model: deepseek/deepseek-v4.1-flash
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      route:
        apiKeyEnv: ROUTE_API_KEY
        api: openai-completions
      command:
        apiKeyEnv: COMMAND_API_KEY
        api: openai-completions
- id: permission
  config:
    mode: auto
`

// ① 顶层条目切分
{
  const { header, entries } = splitTopLevelEntries(HOST)
  ok(entries.length === 5, `顶层条目应 5 条，实际 ${entries.length}`)
  ok(entries.map((e) => e.id).join(',') === ',llm-deepseek,agent-default-model,llm-pi-ai,permission',
    '顶层条目 id 解析不对：' + JSON.stringify(entries.map((e) => e.id)))
  ok(header.includes('Your patch layer'), '文件头没保留下来')
  // insert 的子条目缩进 4 格，不能被切成顶层
  ok(!entries.some((e) => e.id === 'firecrawl-mcp'), 'insert 里的子条目被误当成顶层条目')
}

// ② provider 名解析
{
  const ids = providerIdsOf(HOST)
  ok(ids.has('route') && ids.has('command'), 'providers 映射的直接子键没解析出来：' + [...ids].join(','))
  ok(ids.size === 2, `provider 应只有 route/command，实际 ${ids.size} 个`)
  // 带引号的键
  const q = providerIdsOf('config:\n  providers:\n    \'my-provider\':\n      api: openai-completions\n')
  ok(q.has('my-provider'), '带引号的 provider 键没解析出来')
}

// ③ 该抄谁、不该抄谁
{
  const { entries } = splitTopLevelEntries(HOST)
  const picked = entries.filter(isProviderEntry).map((e) => e.id || 'insert')
  ok(picked.includes('llm-deepseek'), 'llm-deepseek（baseURL/models）没被选上')
  ok(picked.includes('llm-pi-ai'), 'llm-pi-ai（providers）没被选上')
  ok(!picked.includes('agent-default-model'), 'agent-default-model 不该被抄（由 overlay 决定）')
  ok(!picked.includes('insert'), '带 Authorization 的 MCP insert 被抄走了（会泄 token）')
  ok(!picked.includes('permission'), 'permission 不该被抄（只认线路键）')
}

// ④ 拼出来的 patch
{
  const r = buildDutyPatch(TEMPLATE, HOST, { hostProfile: 'desktop' })
  ok(r.copied.join(',') === 'llm-deepseek,llm-pi-ai', 'copied 列表不对：' + JSON.stringify(r.copied))
  ok(r.text.startsWith(TEMPLATE.trimEnd()), '模板原文被改动了（必须原样保留在前面）')
  ok(r.text.includes('- id: llm-pi-ai') && r.text.includes('- id: llm-deepseek'), '线路条目没写进结果')
  ok(!r.text.includes('Bearer'), '把带 token 的 insert 抄进去了（严重）')
  ok(!r.text.includes('firecrawl'), '把 MCP insert 抄进去了')
  ok(!/^- id: agent-default-model[ \t]*$/m.test(r.text.split(AUTO_SECTION_MARK)[1] || ''), '自动段里出现了 agent-default-model')
  ok(r.text.includes(AUTO_SECTION_MARK), '缺少自动段标记')
  ok(r.text.includes('desktop'), '自动段没写明是从哪个 profile 抄的')
  // provider 集合：宿主来的 + 官方兜底
  ok(r.providers.has('route') && r.providers.has('command'), 'provider 集合缺宿主线路')
  ok(r.providers.has('deepseek-account'), 'provider 集合缺模板自带的 deepseek-account')
  ok(r.providers.has('deepseek-official'), '抄了 llm-deepseek 却没把 deepseek-official 算进来')
  ok(r.providersFromHost.size === 2, 'providersFromHost 应只有宿主那 2 个')
}

// ⑤ 幂等：拿自己的输出再跑一次，不能重复追加
{
  const once = buildDutyPatch(TEMPLATE, HOST).text
  const twice = buildDutyPatch(once, HOST).text
  ok(once === twice, '不幂等：第二次拼接和第一次不一样')
  ok(twice.split(AUTO_SECTION_MARK).length === 2, '自动段标记出现了多次：' + (twice.split(AUTO_SECTION_MARK).length - 1))
  ok(twice.split('- id: llm-pi-ai').length === 2, 'llm-pi-ai 被重复抄入')
}

// ⑥ 宿主没有自定义线路（空 patch / 纯官方）
{
  const empty = buildDutyPatch(TEMPLATE, '[]\n')
  ok(empty.copied.length === 0, '空宿主 patch 不该抄东西')
  ok(!empty.text.includes(AUTO_SECTION_MARK), '没东西可抄时不该留自动段')
  ok(empty.text.trim() === TEMPLATE.trim(), '没东西可抄时模板应原样保留')
  ok(empty.providers.has('deepseek-account'), '没东西可抄时仍应认官方账号 provider')
  const officialOnly = buildDutyPatch(TEMPLATE, '- id: agent-default-model\n  config:\n    provider: deepseek-account\n    model: deepseek-flash\n')
  ok(officialOnly.copied.length === 0, '只有 agent-default-model 时不该抄')
}

// ⑦ 第三方 provider 靠 insert 注册的情形也要抄
{
  const host = '- insert:\n    - id: my-llm\n      name: my-llm-plugin\n      config:\n        providers:\n          my-provider:\n            api: openai-completions\n'
  const { entries } = splitTopLevelEntries(host)
  ok(entries.length === 1, 'insert 顶层条目切分不对')
  ok(isProviderEntry(entries[0]), 'insert 里声明 providers 的条目应被抄（第三方 provider 就是这条路）')
  const r = buildDutyPatch(TEMPLATE, host)
  ok(r.copied.join(',') === 'insert', 'copied 应记为 insert')
  ok(r.providers.has('my-provider'), 'insert 里的 provider 没进集合')
}

// ⑧ CRLF / 尾随空格
{
  const crlf = (s) => s.replace(/\n/g, '\r\n')
  const r = buildDutyPatch(crlf(TEMPLATE), crlf(HOST))
  ok(r.copied.join(',') === 'llm-deepseek,llm-pi-ai', 'CRLF 输入没正确处理：' + JSON.stringify(r.copied))
  ok(!/\r\r/.test(r.text), 'CRLF 处理出了双回车')
}

// ⑨ 接线：index.js 真的用了它，且节点都在
{
  const idx = readFileSync(P + 'index.js', 'utf8')
  const diag = readFileSync(P + 'lib/diagnose.mjs', 'utf8')
  ok(/from '\.\/lib\/dutyprofile\.mjs'/.test(idx), 'index.js 没 import dutyprofile')
  ok(idx.includes('syncDutyProviders()'), 'index.js 没有调用 syncDutyProviders()')
  ok(/if \(dutyProfileState === 'ok'\) syncDutyProviders\(\)/.test(idx), '铺成模板后没有立刻同步线路')
  ok(idx.includes('BILI_NO_PROVIDER_SYNC'), '没有 BILI_NO_PROVIDER_SYNC 逃生口')
  ok(idx.includes('dutyRouteProviders.has(prov)'), 'overlay 里没有"provider 是否已注册"的判断')
  ok(idx.includes('dutyRouteSynced && effectiveProfile()'), '判断没有限定在 bili-duty profile 上（会误伤自选 profile）')
  // 顺序：syncDutyProviders 必须在 ensureDutyProfile 之前定义（const 不提升）
  const defAt = idx.indexOf('const syncDutyProviders =')
  const useAt = idx.indexOf('if (dutyProfileState === \'ok\') syncDutyProviders()')
  ok(defAt > 0 && useAt > defAt, 'syncDutyProviders 的定义出现在使用之后（会 TDZ 崩）')
  ok(diag.includes('BILI_NO_PROVIDER_SYNC'), 'diagnose 的排查建议没提到新开关')
  ok(!diag.includes('最省事**：把那个 profile 的模型改回官方'), 'diagnose 里那条过时的建议还在（让用户改会被覆盖的 profile）')
}

if (fail.length) {
  console.error(`❌ 值班 profile 线路同步自检失败（${fail.length}/${total}）：`)
  for (const f of fail) console.error('  - ' + f)
  process.exit(1)
}
console.log(`✅ 值班 profile 线路同步通过（${total} 条断言）`)
