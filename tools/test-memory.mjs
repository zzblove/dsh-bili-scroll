// 长期记忆接入（markdown-project-memory）回归测试
//   node tools/test-memory.mjs
// 不联网、不碰真家目录；spawn 那部分用一个假的 mem.py（JS 写，免依赖 python）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MEM_TYPES, MEM_TOOLS, resolveMemoryRoot, memoryTypes, searchQueryOf, clipText, buildMemoBlock,
  searchArgs, showArgs, addArgs, runMem, addMemory, memoryHealth,
  keyState, writeKey, testSemantic, buildVectorsNow, cliInfo, semanticReady,
} from '../lib/memory.mjs'

const P = join(dirname(fileURLToPath(import.meta.url)), '..') + '/'
const fail = []
let total = 0
const ok = (cond, msg) => { total++; if (!cond) fail.push(msg) }
const tmpRoots = []
const mk = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); tmpRoots.push(d); return d }

/** 造一个"像记忆项目"的目录：scripts/mem.py + memory/index.md */
function fakeMemoryProject({ withMemPy = true, withMemory = true, indexLines = 2 } = {}) {
  const root = mk('bili-mem-')
  if (withMemPy) {
    mkdirSync(join(root, 'scripts'), { recursive: true })
    // 假的 mem.py：用 node 跑（扩展名无所谓），把 argv 原样打出来 —— 验的是"参数怎么传"
    writeFileSync(join(root, 'scripts', 'mem.py'), [
      'const a = process.argv.slice(2)',
      'const cmd = a[0] || ""',
      'if (cmd === "search") process.stdout.write(JSON.stringify({ ok: 1, argv: a }) + "\\n")',
      'else if (cmd === "add") process.stdout.write("wrote " + a[a.length - 1] + "\\n")',
      'else process.stdout.write("cmd=" + cmd + "\\n")',
      'process.exit(0)',
    ].join('\n'), 'utf8')
  }
  if (withMemory) {
    mkdirSync(join(root, 'memory', 'facts'), { recursive: true })
    const idx = ['# 记忆索引', ''].concat(
      Array.from({ length: indexLines }, (_, i) => '- 条目' + (i + 1) + ' — `memory/facts/x' + i + '.md` — 摘要' + (i + 1)),
    ).join('\n')
    writeFileSync(join(root, 'memory', 'index.md'), idx + '\n', 'utf8')
  }
  return root
}

// ① 找记忆根目录
{
  const good = fakeMemoryProject()
  const r1 = resolveMemoryRoot({ memoryDir: good })
  ok(r1.ok && r1.root === good, '显式填了合法目录却没认出来：' + JSON.stringify(r1))

  const noPy = fakeMemoryProject({ withMemPy: false })
  const r2 = resolveMemoryRoot({ memoryDir: noPy })
  ok(!r2.ok && /scripts\/mem\.py/.test(r2.reason), '缺 mem.py 没报对原因：' + JSON.stringify(r2))

  const noMem = fakeMemoryProject({ withMemory: false })
  const r3 = resolveMemoryRoot({ memoryDir: noMem })
  ok(!r3.ok && /memory\//.test(r3.reason), '缺 memory/ 没报对原因：' + JSON.stringify(r3))

  // 没填记忆目录 ⇒ 退到工作区；工作区也不是记忆项目 ⇒ 明确说不带
  const wsGood = fakeMemoryProject()
  const r4 = resolveMemoryRoot({ memoryDir: '', workspace: wsGood })
  ok(r4.ok && r4.root === wsGood && r4.from === '工作区', '工作区兜底没生效：' + JSON.stringify(r4))

  const r5 = resolveMemoryRoot({ memoryDir: '', workspace: mk('bili-ws-') })
  ok(!r5.ok && r5.reason.includes('没有'), '工作区不含记忆时应明确说原因：' + JSON.stringify(r5))

  const r6 = resolveMemoryRoot({})
  ok(!r6.ok, '什么都没填时不该认出一个记忆目录')

  const h = memoryHealth({ memoryDir: good })
  ok(h.ok && h.files === 2, 'memoryHealth 数索引行不对：' + JSON.stringify(h))
}

// ② 检索词
{
  ok(searchQueryOf(['DeepSeek Harness', '插件']) === 'DeepSeek Harness 插件', '关键词拼接不对')
  ok(searchQueryOf([]) === '', '空关键词应返回空串')
  ok(searchQueryOf(['  a  ', '', 'b  ']) === 'a b', '空白项没被清掉')
  ok(searchQueryOf(['x'.repeat(300)]).length <= 200, '检索词没有长度上限')
  ok(searchQueryOf(['a'], '额外') === 'a 额外', 'extra 没拼进去')
}

// ③ 截断
{
  ok(clipText('abc', 10) === 'abc', '没超限时不该改动')
  const long = Array.from({ length: 200 }, (_, i) => '第' + i + '行').join('\n')
  const cut = clipText(long, 200)
  ok(cut.length < long.length && cut.includes('没显示'), '超限时没有截断说明')
  ok(cut.includes('第0行'), '截断不应该从中间切掉开头')
  ok(!/\n$/.test(cut), '截断后不该留尾随换行')
}

// ④ 提示词块
{
  ok(buildMemoBlock({ query: 'x', output: '' }) === '', '没有检索结果时不该拼记忆块')
  ok(buildMemoBlock({ query: '', output: '有内容' }) === '', '没有检索词时不该拼记忆块')
  ok(buildMemoBlock({ query: 'x', output: '无相关记忆' }) === '', '「无相关记忆」不该当成记忆注进去')
  const block = buildMemoBlock({ query: 'dsH 插件', output: '候选1\n候选2', from: '设置里的记忆目录' })
  ok(block.includes('你的长期记忆'), '记忆块缺标题')
  ok(block.includes('dsH 插件'), '记忆块缺检索词')
  ok(block.includes('bili_mem_show'), '记忆块没告诉它怎么回看原文')
  ok(block.includes('以本轮看到的内容为准') || block.includes('以看到的为准'), '记忆块缺"内容优先于记忆"的规矩')
}

// ⑤ 命令参数（安全：一律列表传参，绝不拼 shell）
{
  ok(searchArgs('q').join(' ').includes('--mode local'), 'search 没走本地模式（会读 API key / 联网）')
  // ⚠️ 分号留着是对的：它**留在同一个 argv 元素里**，没有 shell 解释它 ⇒ 不是注入面
  const danger = searchArgs('q; rm -rf /')
  ok(danger[1] === 'q; rm -rf /' && danger.length === 8, '可疑字符把参数个数改变了：' + JSON.stringify(danger))
  ok(showArgs('memory/facts/x.md', { lines: '1-5' }).includes('--lines'), 'show 的 lines 参数没传')
  ok(showArgs('memory/facts/x.md', { grep: 'k' }).includes('--grep'), 'show 的 grep 参数没传')
  const a = addArgs({ type: 'fact', title: 't', summary: 's', bodyFile: 'f' })
  ok(a.join(' ') === 'add --type fact --title t --summary s --body-file f', 'add 参数拼错：' + a.join(' '))
}

// ⑥ 真实 spawn（假 mem.py）
{
  const root = fakeMemoryProject()
  const r = await runMem({ python: process.execPath, root, args: searchArgs('hello world') })
  ok(r.ok, 'runMem 没跑起来：' + r.err)
  ok(r.out.includes('hello world'), '参数没原样传到子进程：' + r.out)
  const parsed = JSON.parse(r.out.trim())
  ok(parsed.argv.length === searchArgs('hello world').length, '参数个数对不上')

  const bad = await runMem({ python: 'definitely-not-a-python-' + Date.now(), root, args: ['search', 'x'] })
  ok(!bad.ok && bad.err, 'python 不存在时应当 ok=false 而不是抛异常')
}

// ⑦ addMemory（写正文临时文件 + 类型校验 + 保留正文）
{
  const root = fakeMemoryProject()
  const okRun = await addMemory({ python: process.execPath, root, type: 'fact', title: 't', summary: 's', body: '正文内容' })
  ok(okRun.ok, 'addMemory 失败：' + okRun.err)
  const badType = await addMemory({ python: process.execPath, root, type: 'secret', title: 't', summary: 's', body: 'b' })
  ok(!badType.ok && /类型只能是/.test(badType.err), '非法类型没被拦住')
  const noRoot = await addMemory({ python: process.execPath, root: '', type: 'fact', title: 't', summary: 's', body: 'b' })
  ok(!noRoot.ok, '没有记忆目录时不该假装成功')
}

// ⑧ 接线：index.js 真的用上了
{
  const idx = readFileSync(P + 'index.js', 'utf8')
  const cli = readFileSync(P + 'client.js', 'utf8')
  const duty = readFileSync(P + 'prompts/duty.md', 'utf8')
  const py = readFileSync(P + 'vendor/bilibili-mcp/mcp_server.py', 'utf8')

  ok(/from '\.\/lib\/memory\.mjs'/.test(idx), 'index.js 没 import memory.mjs')
  ok(idx.includes('memoryDir: z.string().default'), 'Config 里没有 memoryDir')
  ok(idx.includes("if ('memoryDir' in p)"), 'persistCfg 没有钳 memoryDir')
  ok(idx.includes('+ memoCache.block'), '提示词里没有把记忆块拼进去')
  ok(idx.includes('没有预置记忆'), '没检索到记忆时没告诉模型可以自己用 bili_mem_search')
  ok(idx.includes('if (memoryInfo().ok) list.push(...MEM_TOOLS)'), '白名单没按「配了记忆才给工具」下发')
  ok(idx.includes('BILI_MEM_ROOT') && idx.includes('BILI_MEM_PYTHON'), 'overlay 没把记忆根目录传给 MCP')
  ok(idx.includes('await prefetchMemory()'), '手动跑一轮前没有预取记忆')
  ok(idx.includes('Promise.resolve(prefetchMemory())'), '定时器那条路没有预取记忆')
  ok(idx.includes('memory: (() =>'), 'status 里没有记忆状态')

  ok(cli.includes('memoryDir'), '设置页没有记忆目录输入框')
  ok(cli.includes('setMemDir'), '设置页没有记忆目录草稿状态')

  ok(duty.includes('长期记忆'), '章程没有长期记忆那一节')
  ok(duty.includes('一轮最多写 2 条') || duty.includes('最多写 2 条'), '章程没写每轮写记忆的上限')
  ok(duty.includes('不许写密钥'), '章程没写"不许记密钥"')

  ok(py.includes('def bili_mem_search'), 'MCP 缺 bili_mem_search')
  ok(py.includes('def bili_mem_show'), 'MCP 缺 bili_mem_show')
  ok(py.includes('def bili_mem_add'), 'MCP 缺 bili_mem_add')
  ok(!/shell\s*=\s*True/.test(py.split('def _mem_run')[1]?.slice(0, 1200) || ''), 'mem 子进程用了 shell=True（有注入面）')
  ok(py.includes('MEM_TYPES'), 'MCP 没校验记忆类型')
  ok(/startswith\("memory\/"\)/.test(py), 'MCP 没限制 show 只能读 memory/ 下的条目')
  ok(py.includes('BILI_MEM_ROOT'), 'MCP 没读记忆根目录的环境变量')
  ok(MEM_TOOLS.length === 3 && MEM_TOOLS.every((t) => t.startsWith('bili_mem_')), 'MEM_TOOLS 名单不对')
  ok(MEM_TYPES.join(',') === 'fact,decision,howto,correction', '默认记忆类型名单变了')
}

// ⑨ Node 版记忆（memory-kit）：没有 mem.py 也能认出来，并按项目档案取类型
{
  const root = mk('bili-node-mem-')
  mkdirSync(join(root, 'memory'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  // 假的 mem.js：用 node 跑，把 argv 原样打出来（验的是"执行器选对了"）
  writeFileSync(join(root, 'scripts', 'mem.js'), [
    'const a = process.argv.slice(2)',
    'process.stdout.write(JSON.stringify({ argv: a }) + "\\n")',
    'process.exit(0)',
  ].join('\n'), 'utf8')
  const r1 = resolveMemoryRoot({ memoryDir: root })
  ok(r1.ok && r1.runner && r1.runner.kind === 'node', '只有 mem.js 时没认出 Node 执行器：' + JSON.stringify(r1))

  // 有 mem.py 时仍优先 Python（原实现）…
  writeFileSync(join(root, 'scripts', 'mem.py'), 'print("x")\n', 'utf8')
  const r2 = resolveMemoryRoot({ memoryDir: root })
  ok(r2.runner && r2.runner.kind === 'python', '两种脚本都在时应优先 Python：' + JSON.stringify(r2.runner))

  // …但如果项目档案不是 engineering，就必须用 Node（Python 版不认 bili 类型）
  writeFileSync(join(root, 'memory', '.profile.json'), JSON.stringify({ profile: 'bili' }), 'utf8')
  const r2b = resolveMemoryRoot({ memoryDir: root })
  ok(r2b.runner && r2b.runner.kind === 'node', 'bili 档案时没切到 Node 执行器：' + JSON.stringify(r2b.runner))
  rmSync(join(root, 'memory', '.profile.json'), { force: true })

  // 档案：.profile.json 决定可写类型
  writeFileSync(join(root, 'memory', '.profile.json'), JSON.stringify({ profile: 'bili' }), 'utf8')
  ok(memoryTypes(root).join(',') === 'taste,video,talk,creator,correction', 'bili 档案的类型没读出来：' + memoryTypes(root).join(','))
  rmSync(join(root, 'memory', '.profile.json'), { force: true })
  ok(memoryTypes(root).join(',') === 'fact,decision,howto,correction', '没有档案文件时应退回工程类型')

  // Node 执行器真的能跑（用 process.execPath，不需要 python）
  writeFileSync(join(root, 'memory', '.profile.json'), JSON.stringify({ profile: 'bili' }), 'utf8')
  const rr = await runMem({ python: 'definitely-missing-python', runner: { kind: 'node' }, root, args: ['search', 'hello'] })
  ok(rr.ok && rr.out.includes('hello'), 'Node 执行器没跑通（不该依赖 python）：' + rr.err)

  // 类型校验按档案来：bili 项目不许写 fact
  const bad = await addMemory({ runner: { kind: 'node' }, root, type: 'fact', title: 't', summary: 's', body: 'b' })
  ok(!bad.ok && /taste/.test(bad.err), 'bili 项目没拦住 fact 类型：' + JSON.stringify(bad))
}

// ⑩ 接线：执行器与类型都从宿主传到 MCP
{
  const idx = readFileSync(P + 'index.js', 'utf8')
  const py = readFileSync(P + 'vendor/bilibili-mcp/mcp_server.py', 'utf8')
  ok(idx.includes('memoryTypes'), 'index.js 没 import memoryTypes')
  ok(idx.includes('BILI_MEM_RUNNER'), 'overlay 没下发执行器')
  ok(idx.includes('BILI_MEM_TYPES'), 'overlay 没下发类型名单')
  ok(idx.includes('BILI_MEM_NODE'), 'overlay 没给 Node 版传 node 路径')
  ok(py.includes('def _mem_cmd'), 'MCP 没有执行器选择逻辑')
  ok(py.includes('BILI_MEM_RUNNER'), 'MCP 没读执行器变量')
  ok(py.includes('BILI_MEM_TYPES'), 'MCP 没读类型名单')
}

// ⑪ 语义检索（嵌入 + 重排）：参数按执行器分开拼，默认仍必须是本地
{
  const idx = readFileSync(P + 'index.js', 'utf8')
  const cli = readFileSync(P + 'client.js', 'utf8')
  const py = readFileSync(P + 'vendor/bilibili-mcp/mcp_server.py', 'utf8')

  const nodeSem = searchArgs('q', { semantic: true, runnerKind: 'node' })
  ok(nodeSem.includes('--semantic'), 'Node 版语义检索没加 --semantic：' + JSON.stringify(nodeSem))
  const nodeLocal = searchArgs('q', { semantic: false, runnerKind: 'node' })
  ok(!nodeLocal.includes('--semantic'), 'Node 版默认不该带 --semantic：' + JSON.stringify(nodeLocal))
  const pySem = searchArgs('q', { semantic: true })
  ok(pySem.includes('auto') && !pySem.includes('local'), 'Python 版语义检索应走 --mode auto：' + JSON.stringify(pySem))
  const pyLocal = searchArgs('q', { semantic: false })
  ok(pyLocal.includes('local'), 'Python 版默认应走 --mode local（不花钱）：' + JSON.stringify(pyLocal))

  ok(idx.includes('memorySemantic: z.boolean()'), 'Config 里没有 memorySemantic')
  ok(idx.includes("if ('memorySemantic' in p)"), 'persistCfg 没处理 memorySemantic')
  ok(idx.includes('semantic: Boolean(cfg.memorySemantic)'), '预取没把 semantic 传给检索')
  ok(idx.includes('BILI_MEM_SEMANTIC'), 'overlay 没下发语义开关')
  ok(cli.includes('用嵌入 + 重排做语义检索'), '设置页没有语义检索开关')
  ok(py.includes('BILI_MEM_SEMANTIC') && py.includes('def _mem_search_args'), 'MCP 没按语义开关拼检索参数')
  // key 只能由 CLI 自己从文件/环境读，宿主不该把它写进 overlay 的 env（那一行会进 duty.log/overlay 文件）
  ok(!/'\s+MEMORY_API_KEY:\s*'/.test(idx), 'API key 被写进了 overlay env（应由 CLI 自己读 ~/.mem_api_key）')
}

// ⑫ 语义检索的 key 管理 / 自检 / 建向量（2.5.0）
{
  const root = mk('bili-key-')
  mkdirSync(join(root, 'memory'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'mem.js'), [
    "export const VERSION = '1.2.0'",
    "process.stdout.write('[1] fake\\n[2] fake2\\n')",
    'process.exit(0)',
  ].join('\n'), 'utf8')
  writeFileSync(join(root, 'scripts', 'semantic.mjs'), 'export const ok = true\n', 'utf8')

  // 用一个空的 MEMORY_HOME，隔离本机真实的 ~/.mem_api_key
  const noHome = mk('nohome-')
  ok(!keyState(root, { MEMORY_HOME: noHome }).set, '空目录不该报告已配置 key')
  const w = writeKey(root, 'sk-test-12345678')
  ok(w.ok && w.set, '写 key 失败：' + JSON.stringify(w))
  const st1 = keyState(root, { MEMORY_HOME: noHome })
  ok(st1.set && st1.source === 'project', '项目内 key 没被识别：' + JSON.stringify(st1))
  ok(readFileSync(join(root, 'scripts', '.mem_api_key'), 'utf8').trim() === 'sk-test-12345678', 'key 文件内容不对')
  ok(!writeKey(root, 'bad key with spaces').ok, '非法 key 没被拒')
  const cleared = writeKey(root, '')
  ok(cleared.ok && !cleared.set && !keyState(root, { MEMORY_HOME: noHome }).set, '清空 key 没生效')
  ok(keyState(root, { MEMORY_API_KEY: 'from-env' }).source === 'env', '环境变量来源没被识别')

  const t = await testSemantic({ runner: { kind: 'node' }, root, timeoutMs: 8000 })
  ok(t.ok && t.hits === 2 && Number.isFinite(t.ms), '自检没解析出命中条数：' + JSON.stringify(t).slice(0, 160))

  // ⭐ 版本守卫：项目里那份 CLI 旧了 / 缺 semantic.mjs 时，自检必须**明说**而不是静默退回关键词
  const old = mk('bili-oldcli-')
  mkdirSync(join(old, 'memory'), { recursive: true })
  mkdirSync(join(old, 'scripts'), { recursive: true })
  writeFileSync(join(old, 'scripts', 'mem.js'), "export const VERSION = '1.1.0'\nprocess.stdout.write('[1] keyword\\n')\n", 'utf8')
  const tOld = await testSemantic({ runner: { kind: 'node' }, root: old, timeoutMs: 8000 })
  ok(!tOld.ok && /1\.2\.0/.test(String(tOld.err)), '旧版 CLI 没被版本守卫拦住：' + JSON.stringify(tOld).slice(0, 200))
  writeFileSync(join(old, 'scripts', 'mem.js'), "export const VERSION = '1.2.0'\nprocess.stdout.write('[1] x\\n')\n", 'utf8')
  const tNoMod = await testSemantic({ runner: { kind: 'node' }, root: old, timeoutMs: 8000 })
  ok(!tNoMod.ok && /semantic\.mjs/.test(String(tNoMod.err)), '缺 semantic.mjs 没被拦住：' + JSON.stringify(tNoMod).slice(0, 200))
  ok(cliInfo(old, { kind: 'node' }).version === '1.2.0', 'cliInfo 没读出 CLI 版本')
  ok(!semanticReady(old, { kind: 'node' }).ok, 'semanticReady 对缺模块的目录应判 false')
  ok(semanticReady(root, { kind: 'node' }).ok, 'semanticReady 对健康目录应判 true')
  ok(semanticReady(old, { kind: 'python' }).ok, 'Python 版应始终视为支持语义')

  const v = await buildVectorsNow({ runner: { kind: 'node' }, root, timeoutMs: 8000 })
  ok(v.ok && Number.isFinite(v.ms), '建向量调用没跑通：' + JSON.stringify(v).slice(0, 160))

  const idx = readFileSync(P + 'index.js', 'utf8')
  const cli = readFileSync(P + 'client.js', 'utf8')
  ok(idx.includes('/api/bili-duty/memory/key'), '缺写 key 的接口')
  ok(idx.includes('/api/bili-duty/memory/test'), '缺语义自检接口')
  ok(idx.includes('/api/bili-duty/memory/vectors'), '缺建向量接口')
  ok(idx.includes('keyState(') && !idx.includes('key: cfg.memoryApiKey'), 'status 应给出 key 来源且不读配置里的 key')
  ok(cli.includes('测一下语义检索') && cli.includes('现在就建向量'), '设置页缺两个按钮')
  ok(cli.includes("type: 'password'"), 'key 输入框不是 password 类型（会明文显示）')
}

// ⑬ 可信度（stated / inferred）：工具、章程、规范都要跟得上
{
  const py = readFileSync(P + 'vendor/bilibili-mcp/mcp_server.py', 'utf8')
  const duty = readFileSync(P + 'prompts/duty.md', 'utf8')
  ok(/def bili_mem_add\([^)]*confidence/.test(py), 'MCP bili_mem_add 没有 confidence 参数')
  ok(py.includes('confidence 只能是 stated / inferred'), 'MCP 没校验 confidence 取值')
  ok(/if MEM_RUNNER == "node":\s*\n\s*args \+= \["--confidence", conf\]/.test(py), '--confidence 只应传给 Node 版（Python 版会报错）')
  ok(duty.includes('推断不是事实'), '章程没写「推断不是事实」')
  ok(duty.includes('没检索到就不许说'), '章程没写「没检索到不许说记得」')
  ok(duty.includes('不许虚构共同经历'), '章程没写「不许虚构共同经历」')
  ok(duty.includes('confidence'), '章程没提 confidence 参数')
  // 负面清单（借鉴"机械化行为"那套，改成适合刷B站的六条）
  for (const t of ['无条件的夸奖', '严肃/技术话题里卖萌', '为了显得亲近而编故事', '把闲聊变成任务清单', '同一个口癖', '硬下结论']) {
    ok(duty.includes(t), '章程负面清单缺：' + t)
  }
}

for (const d of tmpRoots) { try { rmSync(d, { recursive: true, force: true }) } catch { /* 清不掉也无所谓 */ } }

if (fail.length) {
  console.error(`❌ 长期记忆接入自检失败（${fail.length}/${total}）：`)
  for (const f of fail) console.error('  - ' + f)
  process.exit(1)
}
console.log(`✅ 长期记忆接入通过（${total} 条断言）`)
