// v4.13.0 AI 试卷识别探针
//
// 用法：node scripts/probe-ai-parse.mjs
//
// 背景：用户反馈 Word 导入的两个功能「完全瘫痪 / 太难用」：
//   ① 拖动分割题目完全瘫痪
//   ② 自动切割题目 + 读取答案和解析太难用
// 修复方案：① 重写拖动（见 probe-split-editor.mjs）
//          ② 接入 AI 做结构识别，正则降级兜底
//
// 【v4.13.0 重要变更】
//   用户原话：「就是 Google 这个我弄不了 你把他改成用 cf workers AI 里面的
//   免费模型 智谱的 api 我完了给你 或者是 超级管理员可以在管理界面设置」
//   → 主通道从 Google Gemini 迁移到 Cloudflare Workers AI（零配置、无密钥）；
//     智谱降级为可选备份，Key 由超管在管理后台填写。
//
// 本探针验证核心不变量，**不需要真实 API Key**：
//   · JSON 容错解析（模型最爱加 ```json ``` 围栏 / 前后寒暄 / 尾逗号）
//   · 字段归一 —— **v4.13.0 新增的重点**：
//       实测 @cf/zai-org/glm-4.7-flash 会输出中文键名（题目/选项/答案/解析）
//       与对象形态选项（{"A":"…","B":"…"}）。不接住 → 选项整个丢失。
//   · 降级逻辑（通道不可用 → 返回空结果而非抛错；CF 失败 → 切智谱）
//   · 配置合并（后台配置优先于环境变量、Key 脱敏）
//   · 安全（错误信息不回显 key）
//   · 前后端一致性（worker-api 与 server 走同一个共享模块）
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const ROOT = '/workspace/zhuiguang'
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name) }
  else { fail++; console.log('  ❌', name, extra ? `→ ${extra}` : '') }
}

const server = await createServer({
  root: ROOT, logLevel: 'error',
  server: { middlewareMode: true }, appType: 'custom',
})

try {
  const mod = await server.ssrLoadModule('/shared/ai-paper.ts')
  const {
    extractJson, normalizeQuestions, normalizeOptions, aiAvailable, aiParsePaper,
    sanitizeAiConfig, mergeAiConfig, maskKey, effectiveProvider,
    DEFAULT_AI_CONFIG, DEFAULT_MODEL_CF,
    // 【v4.13.1】表格/图片保真
    htmlToStructuredText, restoreImages, mergeContent,
  } = mod

  console.log('=== 1. JSON 容错解析（模型不听话的三种典型形态）===')
  ok('裸 JSON 可解析',
    extractJson('{"questions":[{"content":"x"}]}')?.questions?.[0]?.content === 'x')

  const fenced = '```json\n{"questions":[{"content":"y"}]}\n```'
  ok('```json 围栏可剥掉（模型最常犯）',
    extractJson(fenced)?.questions?.[0]?.content === 'y')

  const fencedNoLang = '```\n{"questions":[{"content":"z"}]}\n```'
  ok('无语言标记的围栏也能剥',
    extractJson(fencedNoLang)?.questions?.[0]?.content === 'z')

  const chatty = '好的，以下是根据您提供的试卷解析出的结果：\n{"questions":[{"content":"a"}]}\n希望对您有帮助！'
  ok('前后带寒暄可裁剪出 JSON',
    extractJson(chatty)?.questions?.[0]?.content === 'a')

  ok('尾逗号可容错', extractJson('{"questions":[],}') !== null)
  ok('中文引号可容错',
    extractJson('{“questions”:[{“content”:“q”}]}')?.questions?.[0]?.content === 'q')
  ok('完全非 JSON → 返回 null 而不抛异常', extractJson('抱歉我无法处理') === null)
  ok('空输入 → null', extractJson('') === null)

  console.log('\n=== 2. 字段归一（模型输出千奇百怪，必须都收敛）===')
  const qs1 = normalizeQuestions({
    questions: [
      { qtype: 'single', content: '题干A', options: ['A. 甲', 'B. 乙'], answer: 'A', analysis: '解析A', score: 3 },
    ],
  })
  ok('标准输入 → 1 题', qs1.length === 1)
  ok('选项剥掉 A./B. 前缀', qs1[0].options[0] === '甲' && qs1[0].options[1] === '乙', JSON.stringify(qs1[0].options))
  ok('答案/解析/分值保留', qs1[0].answer === 'A' && qs1[0].analysis === '解析A' && qs1[0].score === 3)

  const qs2 = normalizeQuestions({ questions: [{ qtype: '多选题', content: '题干B', options: ['甲', '乙'] }] })
  ok('中文题型「多选题」→ multiple', qs2[0].qtype === 'multiple', qs2[0]?.qtype)

  const qs3 = normalizeQuestions({ questions: [{ qtype: '判断', content: '题干C' }] })
  ok('中文题型「判断」→ judge', qs3[0].qtype === 'judge')

  const qs4 = normalizeQuestions({ questions: [
    { content: '题干D', options: ['(A) 甲', '（B）乙', 'C、丙', 'D．丁'] },
  ] })
  ok('四种选项前缀写法都能剥（(A) （B） C、 D．）',
    JSON.stringify(qs4[0].options) === JSON.stringify(['甲', '乙', '丙', '丁']), JSON.stringify(qs4[0].options))

  const qs5 = normalizeQuestions({ questions: [
    { content: '' },            // 空题干 → 丢弃
    { content: '有效题' },
    null,                        // 脏数据 → 跳过
    'not-an-object',
  ] })
  ok('空题干/脏数据被跳过而不抛', qs5.length === 1, `实际 ${qs5.length}`)

  const qs6 = normalizeQuestions({ questions: [{ content: '缺字段题' }] })
  ok('缺 answer/analysis/score → 填空值不抛',
    qs6[0].answer === '' && qs6[0].analysis === '' && qs6[0].score === 5)

  ok('模型用 stem/solution 等别名也能识别',
    normalizeQuestions({ questions: [{ stem: '别名题干', solution: '别名解析' }] })[0]?.analysis === '别名解析')

  ok('无 options 且非选择题 → subjective',
    normalizeQuestions({ questions: [{ content: '解答题' }] })[0].qtype === 'subjective')

  // ── v4.13.0 新增：实测 CF glm-4.7-flash 的输出形态 ──────────────────────
  console.log('\n=== 2b. Cloudflare GLM 实测输出形态（v4.13.0 新增）===')
  console.log('    实测样本（真实抓自 @cf/zai-org/glm-4.7-flash）：')
  console.log('    {"题目":"下列函数中是增函数的是（ ）","选项":[{"选项":"A","内容":"y=-x"},…],"答案":"B"}')

  const cfRaw = {
    questions: [{
      '题目': '下列函数中是增函数的是（ ）',
      '选项': [
        { '选项': 'A', '内容': 'y=-x' },
        { '选项': 'B', '内容': 'y=x²' },
      ],
      '答案': 'B',
      '解析': '单调递增。',
    }],
  }
  const cf = normalizeQuestions(cfRaw)
  ok('⚠️ 中文键名（题目/选项/答案/解析）能被识别', cf.length === 1, `实际 ${cf.length} 题`)
  ok('⚠️ 中文题干正确取到', cf[0]?.content === '下列函数中是增函数的是（ ）', cf[0]?.content)
  ok('⚠️ 中文答案正确取到', cf[0]?.answer === 'B', cf[0]?.answer)
  ok('⚠️ 中文解析正确取到', cf[0]?.analysis === '单调递增。', cf[0]?.analysis)
  ok('⚠️ 嵌套对象选项 [{选项,内容}] 能归一为纯文本数组',
    JSON.stringify(cf[0]?.options) === JSON.stringify(['y=-x', 'y=x²']), JSON.stringify(cf[0]?.options))

  // 对象形态选项：{"A":"…","B":"…"} —— glm-4.7-flash 最常犯
  const objOpts = normalizeOptions({ A: 'y=-x', B: 'y=x²', C: 'y=x³', D: 'y=x⁴' })
  ok('⚠️ 对象形态选项 {"A":"…"} 能归一（且按 A→D 排序）',
    JSON.stringify(objOpts) === JSON.stringify(['y=-x', 'y=x²', 'y=x³', 'y=x⁴']), JSON.stringify(objOpts))

  ok('对象形态选项的键序被打乱后仍按字母排序',
    JSON.stringify(normalizeOptions({ C: '三', A: '一', B: '二' })) === JSON.stringify(['一', '二', '三']))

  ok('中文题型「单选题」→ single', normalizeQuestions({ questions: [{ 题目: 'x', options: ['a', 'b'] }] })[0]?.qtype === 'single')

  ok('顶层中文键「题目」也能接（模型不带 questions 包裹）',
    normalizeQuestions({ '题目': [{ content: '裸数组题干' }] }).length === 1)

  console.log('\n=== 2c. 表格与图片保真（v4.13.1 新增 · 用户反馈「直接吞了」）===')
  // 用户原话：「有个问题 遇到表格 图片之类的 AI 就不是别 直接吞了」
  // 根因两处：① 送 AI 的是纯文本（表格拍平、图片空 text 被 filter 掉）
  //          ② AI 回填时用纯文本整体覆盖原卷 HTML（table/img 永久丢失）
  // 修法：送 AI 前做「表格 Markdown 化 + 图片占位符化」，回填时以原卷 HTML 为准。

  // —— ① HTML → 结构化文本：表格保住行列 ——
  const tblHtml = '<p>1. 根据下表数据回答问题</p>' +
    '<table><tr><th>年份</th><th>产量</th></tr><tr><td>2020</td><td>1.2</td></tr><tr><td>2021</td><td>3.4</td></tr></table>'
  const st1 = htmlToStructuredText(tblHtml)
  ok('表格被转成 Markdown（含表头分隔行）',
    /\|\s*年份\s*\|\s*产量\s*\|/.test(st1.text) && /\|\s*-{3,}\s*\|/.test(st1.text), JSON.stringify(st1.text))
  ok('⭐ 表格数据行完整保留（行列关系不丢）',
    /\|\s*2020\s*\|\s*1\.2\s*\|/.test(st1.text) && /\|\s*2021\s*\|\s*3\.4\s*\|/.test(st1.text), JSON.stringify(st1.text))
  ok('表格前的题干文字保留', st1.text.includes('根据下表数据回答问题'))

  // —— ② HTML → 结构化文本：图片转占位符并记录 src ——
  const imgHtml = '<p>2. 如图所示，求阴影面积</p><p><img src="https://cdn.test/a.png"></p>'
  const st2 = htmlToStructuredText(imgHtml)
  ok('⭐ 图片转成 [图1] 占位符（位置可寻）', st2.text.includes('[图1]'), JSON.stringify(st2.text))
  ok('⭐ 图片 src 被记录下来（供回填）', st2.images['图1'] === 'https://cdn.test/a.png', JSON.stringify(st2.images))
  ok('图片不再整块消失（题干文字仍在）', st2.text.includes('求阴影面积'))

  // —— ③ 多图编号递增 + startIdx 续编 ——
  const st3 = htmlToStructuredText('<p><img src="u1"><img src="u2"></p>')
  ok('多图编号递增（图1/图2）',
    st3.text.includes('[图1]') && st3.text.includes('[图2]') && st3.images['图2'] === 'u2', JSON.stringify(st3.images))
  const st4 = htmlToStructuredText('<p><img src="u3"></p>', 5)
  ok('startIdx 可续编（分块调用时不重复从图1开始）',
    st4.text.includes('[图5]') && st4.images['图5'] === 'u3', JSON.stringify(st4.images))

  // —— ④ 表格+图片混合，且单元格内含换行/竖线 ——
  const mix = htmlToStructuredText(
    '<table><tr><td>a<br>b</td><td>x|y</td></tr></table><p>见图 [图]</p><img src="u9">')
  ok('单元格内 <br> 变空格、竖线被转义（不破坏 Markdown 结构）',
    /\|\s*a b\s*\|/.test(mix.text) && mix.text.includes('x\\|y'), JSON.stringify(mix.text))
  ok('混合场景图片仍被正确编号', mix.images['图1'] === 'u9', JSON.stringify(mix.images))

  // —— ⑤ 纯文本输入不受影响（不误伤）——
  const plain = htmlToStructuredText('1. 纯文本题目 x < 3 且 y > 2')
  ok('纯文本原样返回（数学不等号不被当标签）', plain.text.includes('x < 3') && plain.text.includes('y > 2'), JSON.stringify(plain.text))

  // —— ⑥ [图N] 占位符回填成 <img> ——
  const restored = restoreImages('<p>如图[图1]所示</p>', { 图1: 'https://cdn.test/b.png' })
  ok('⭐ [图1] 回填成真正的 <img> 标签', /<img src="https:\/\/cdn\.test\/b\.png"/.test(restored), restored)
  ok('全角方括号 ［图1］ 也能识别', /<img/.test(restoreImages('<p>［图1］</p>', { 图1: 'u' })))
  ok('「图 1」中间带空格也能识别', /<img/.test(restoreImages('<p>[图 1]</p>', { 图1: 'u' })))
  ok('映射里没有该图 → 原样保留（不生成空 img）',
    restoreImages('<p>[图9]</p>', { 图1: 'u' }).includes('[图9]'))
  ok('无 images 映射 → 原样返回不抛', restoreImages('<p>[图1]</p>', undefined) === '<p>[图1]</p>')

  // —— ⑦ mergeContent：原卷 HTML 为准，AI 只补元数据 ——
  const origRich = '<p>3. 根据下表求值</p><table><tr><td>1</td></tr></table>'
  const mc1 = mergeContent(origRich, '3. 根据下表求值（AI 把表格弄丢了）', {})
  ok('⭐ 原卷含表格 → 合并后表格仍在（AI 不能覆盖掉）',
    mc1.includes('<table>'), mc1)
  const origImg = '<p>4. 如图</p><img src="real.png">'
  const mc2 = mergeContent(origImg, '4. 如图', {})
  ok('⭐ 原卷含图片 → 合并后图片仍在', mc2.includes('<img src="real.png"'), mc2)
  const mc3 = mergeContent('', '纯 AI 题干[图1]', { 图1: 'u1' })
  ok('原卷为空 → 采用 AI 题干并回填图片', /<img/.test(mc3) && mc3.includes('纯 AI 题干'), mc3)
  const mc4 = mergeContent('<p>文字题干</p>', '', {})
  ok('AI 没给题干 → 保留原卷（不会变成空）', mc4.includes('文字题干'))

  console.log('\n=== 3. 降级逻辑（通道不可用时功能不能崩）===')
  ok('无任何通道 → aiAvailable=false', aiAvailable({}) === false)
  ok('有 CF 绑定 → available', aiAvailable({ AI: { run: () => {} } }) === true)
  ok('只有智谱 Key → available', aiAvailable({ ZHIPU_API_KEY: 'x' }) === true)
  ok('⭐ 用户核心诉求：只绑 CF 绑定、零密钥 → 可用',
    aiAvailable({ AI: { run: () => {} } }) === true)

  const r0 = await aiParsePaper({}, '试卷文本')
  ok('无通道调 aiParsePaper → 返回对象且 questions 空（不抛异常，调用方好降级）',
    r0 !== null && typeof r0 === 'object' && Array.isArray(r0.questions) && r0.questions.length === 0, String(r0))

  // CF 通道：绑定存在但模型必失败 → 应记录 attempt 且不抛
  const badAi = { run: async () => { throw new Error('model unavailable in test') } }
  const r1 = await aiParsePaper({ AI: badAi }, '题目1. 测试', { timeoutMs: 3000 })
  ok('CF 绑定报错 → 不抛异常，返回结果对象', r1 !== null && typeof r1 === 'object')
  ok('CF 绑定报错 → questions 为空数组', Array.isArray(r1?.questions) && r1.questions.length === 0)
  ok('CF 绑定报错 → attempts 记录失败原因（便于排查）',
    Array.isArray(r1?.attempts) && r1.attempts.length > 0 && !!r1.attempts[0].error)
  ok('CF 失败时 attempts 里的 provider 是 cf', r1?.attempts?.[0]?.provider === 'cf', JSON.stringify(r1?.attempts?.[0]))

  // CF 主力成功 → 不应触发备用模型
  let cfCalls = 0
  const goodAi = {
    run: async () => {
      cfCalls++
      return { choices: [{ message: { content: '{"questions":[{"qtype":"single","content":"CF题干","options":["甲","乙"],"answer":"A"}]}' } }] }
    },
  }
  const r2 = await aiParsePaper({ AI: goodAi }, '题目1. CF', { timeoutMs: 3000 })
  ok('CF 主力模型成功 → 正确解析出题目', r2?.questions?.length === 1, JSON.stringify(r2?.questions))
  ok('CF 主力成功 → 只调用一次（不浪费备用模型额度）', cfCalls === 1, `实际 ${cfCalls} 次`)
  ok('CF 成功 → provider 标记为 cf', r2?.provider === 'cf', r2?.provider)
  ok('CF 成功 → model 记录实际使用的模型', typeof r2?.model === 'string' && r2.model.startsWith('@cf/'), r2?.model)

  // CF 主力失败 → 自动切备用模型（模型级降级）
  cfCalls = 0
  const flakyAi = {
    run: async (model) => {
      cfCalls++
      if (model === DEFAULT_MODEL_CF) throw new Error('primary down')
      return { choices: [{ message: { content: '{"questions":[{"content":"备用模型题干"}]}' } }] }
    },
  }
  const r3 = await aiParsePaper({ AI: flakyAi }, '题目1. 降级', { timeoutMs: 3000 })
  ok('⚠️ CF 主力失败 → 自动切备用模型（模型级降级）', r3?.questions?.length === 1, JSON.stringify(r3?.questions))
  ok('⚠️ 模型级降级确实调用了两次', cfCalls === 2, `实际 ${cfCalls} 次`)
  ok('降级后 model 记录的是备用模型（不是主力）', r3?.model !== DEFAULT_MODEL_CF, r3?.model)

  // 主力=备用时不应重复调用同一模型
  cfCalls = 0
  await aiParsePaper(
    { AI: badAi, AI_MODEL_CF: '@cf/x', AI_MODEL_CF_FALLBACK: '@cf/x' },
    '题', { timeoutMs: 2000 }
  )
  ok('主力与备用同名时只调一次（避免重复烧额度）', cfCalls === 0, `实际 ${cfCalls} 次`)

  const r4 = await aiParsePaper({ ZHIPU_API_KEY: 'invalid-key-for-test', AI_PROVIDER: 'zhipu' }, '题目1. 测试', { timeoutMs: 8000 })
  ok('智谱 Key 无效 → 不抛异常，返回结果对象', r4 !== null && typeof r4 === 'object')
  const errText = JSON.stringify(r4?.attempts || [])
  ok('⚠️ 安全：失败信息里不回显 Key 值', !errText.includes('invalid-key-for-test'), errText.slice(0, 120))

  console.log('\n=== 4. 配置合并与脱敏（v4.13.0 新增）===')
  ok('sanitizeAiConfig 非法 provider → 回落 auto',
    sanitizeAiConfig({ provider: 'gpt5' }).provider === 'auto')
  ok('sanitizeAiConfig 合法 provider 保留',
    sanitizeAiConfig({ provider: 'zhipu' }).provider === 'zhipu')
  // ⚠️ 回归：sanitizeAiConfig **不能**给空字段填默认值。
  //   否则「后台只改了 provider」会连带把 modelCf 也覆盖成默认值，
  //   导致部署时配好的 AI_MODEL_CF 环境变量静默失效（本探针实测抓到过）。
  ok('⚠️ sanitizeAiConfig 空字段保持空串（不填默认值，防覆盖环境变量）',
    sanitizeAiConfig({}).modelCf === '' && sanitizeAiConfig({}).modelZhipu === '',
    `modelCf="${sanitizeAiConfig({}).modelCf}"`)

  const merged = mergeAiConfig({ AI: badAi, ZHIPU_API_KEY: 'env-key', AI_MODEL_CF: '@cf/env-model' }, {
    provider: 'zhipu', modelCf: '@cf/db-model', modelCfFallback: '@cf/db-fb', modelZhipu: 'glm-4-flash', zhipuKey: 'db-key',
  })
  ok('⚠️ 后台配置优先于环境变量（provider）', merged.AI_PROVIDER === 'zhipu', merged.AI_PROVIDER)
  ok('⚠️ 后台配置优先于环境变量（modelCf）', merged.AI_MODEL_CF === '@cf/db-model', merged.AI_MODEL_CF)
  ok('⚠️ 后台配置优先于环境变量（zhipuKey）', merged.ZHIPU_API_KEY === 'db-key', merged.ZHIPU_API_KEY)
  ok('⭐ env.AI 绑定被保留（后台配置造不出 binding）', merged.AI === badAi)

  // DEFAULT_AI_CONFIG 里模型字段有值 —— 它代表"用户显式选择了这些模型"，
  // 所以此时后台值优先是**正确**行为（不是 bug）。
  const merged2 = mergeAiConfig({ ZHIPU_API_KEY: 'env-key', AI_MODEL_CF: '@cf/env-model' }, { ...DEFAULT_AI_CONFIG })
  ok('后台显式选了模型 → 后台优先（modelCf）', merged2.AI_MODEL_CF === DEFAULT_MODEL_CF, merged2.AI_MODEL_CF)
  ok('后台未配 Key（空串）→ 回落到环境变量 Key', merged2.ZHIPU_API_KEY === 'env-key', merged2.ZHIPU_API_KEY)

  // 真正代表"后台从没配过"的是 sanitizeAiConfig({})
  const neverConfigured = mergeAiConfig({ ZHIPU_API_KEY: 'env-key', AI_MODEL_CF: '@cf/env-model' }, sanitizeAiConfig({}))
  ok('⚠️ 后台从没配过 → 环境变量的 modelCf 生效',
    neverConfigured.AI_MODEL_CF === '@cf/env-model', neverConfigured.AI_MODEL_CF)
  ok('⚠️ 后台从没配过 → 环境变量的 zhipuKey 生效',
    neverConfigured.ZHIPU_API_KEY === 'env-key', neverConfigured.ZHIPU_API_KEY)

  // ⚠️ 关键回归：模拟"超管只改了 provider，其余字段留空"的真实场景。
  //   此时环境变量里配好的模型必须仍然生效，不能被默认值顶掉。
  const partial = mergeAiConfig(
    { AI: badAi, AI_MODEL_CF: '@cf/env-model', AI_MODEL_CF_FALLBACK: '@cf/env-fb', AI_MODEL_ZHIPU: 'env-glm' },
    sanitizeAiConfig({ provider: 'cf' })
  )
  ok('⚠️ 超管只改 provider 时，环境变量的 modelCf 仍生效',
    partial.AI_MODEL_CF === '@cf/env-model', partial.AI_MODEL_CF)
  ok('⚠️ 超管只改 provider 时，环境变量的 modelCfFallback 仍生效',
    partial.AI_MODEL_CF_FALLBACK === '@cf/env-fb', partial.AI_MODEL_CF_FALLBACK)
  ok('⚠️ 超管只改 provider 时，环境变量的 modelZhipu 仍生效',
    partial.AI_MODEL_ZHIPU === 'env-glm', partial.AI_MODEL_ZHIPU)
  ok('超管只改 provider 时，provider 用的是后台值',
    partial.AI_PROVIDER === 'cf', partial.AI_PROVIDER)

  // 环境变量也空时，才轮到内置默认值兜底
  const nothing = mergeAiConfig({}, sanitizeAiConfig({}))
  ok('环境变量与后台都为空 → 内置默认值兜底（modelCf）',
    nothing.AI_MODEL_CF === DEFAULT_MODEL_CF, nothing.AI_MODEL_CF)
  ok('环境变量与后台都为空 → 内置默认值兜底（provider=auto）',
    nothing.AI_PROVIDER === 'auto', nothing.AI_PROVIDER)

  ok('maskKey 只留前4后4', maskKey('abcdefghijklmnop') === 'abcd****mnop', maskKey('abcdefghijklmnop'))
  ok('maskKey 短串全打码', maskKey('short') === '****', maskKey('short'))
  ok('maskKey 空串 → 空串（不显示 **** 误导用户）', maskKey('') === '', maskKey(''))
  ok('maskKey 结果必含 **** （前端据此识别"未修改"）', maskKey('abcdefghijklmnop').includes('****'))

  ok('effectiveProvider: auto + 只有 CF → cf',
    effectiveProvider({ AI: badAi, AI_PROVIDER: 'auto' }) === 'cf')
  ok('effectiveProvider: auto + 只有智谱 → zhipu',
    effectiveProvider({ ZHIPU_API_KEY: 'k', AI_PROVIDER: 'auto' }) === 'zhipu')
  ok('effectiveProvider: 指定 cf 但没绑 → 空串（诚实反映不可用）',
    effectiveProvider({ AI_PROVIDER: 'cf' }) === '')
  ok('effectiveProvider: 都不可用 → 空串',
    effectiveProvider({}) === '')

  console.log('\n=== 5. 前后端共用同一实现（铁律#11）===')
  const worker = readFileSync(`${ROOT}/worker-api.ts`, 'utf8')
  const local = readFileSync(`${ROOT}/server/index.ts`, 'utf8')
  const shared = readFileSync(`${ROOT}/shared/ai-paper.ts`, 'utf8')

  ok('worker-api.ts 从共享模块导入', /from '\.\/shared\/ai-paper'/.test(worker))
  ok('server/index.ts 从共享模块导入', /from '\.\.\/shared\/ai-paper'/.test(local))
  ok('两端都提供 GET /api/ai/status', worker.includes("'/api/ai/status'") && local.includes("'/api/ai/status'"))
  ok('两端都提供 POST /api/ai/parse-paper', worker.includes("'/api/ai/parse-paper'") && local.includes("'/api/ai/parse-paper'"))
  ok('worker 接口有权限校验（requireSubjectStaff 或 role 判断）',
    /ai\/parse-paper[\s\S]{0,2500}无权操作该学科/.test(worker))
  ok('server 接口有权限校验', /无权操作该学科/.test(local))

  // ── v4.13.0 新增接口：AI 设置（超管在管理界面配置）
  console.log('\n=== 5b. AI 设置接口（超管后台配置，v4.13.0 新增）===')
  for (const [name, src] of [['worker', worker], ['server', local]]) {
    ok(`${name} 提供 GET /api/settings/ai_config`, src.includes("'/api/settings/ai_config'"))
    ok(`${name} 提供 PUT /api/settings/ai_config`, src.includes("'/api/settings/ai_config'"))
    ok(`${name} 提供 POST /api/settings/ai_config/test`, src.includes("'/api/settings/ai_config/test'"))
    ok(`${name} AI 设置接口要求 ai_settings 权限`,
      /settings\/ai_config[\s\S]{0,200}requirePerm\('ai_settings'\)/.test(src))
    // 【安全】GET 必须脱敏下发
    ok(`${name} GET 返回的 Key 经过 maskKey（不发明文）`,
      /ai_config[\s\S]{0,800}maskKey\(/.test(src))
    // 【防坑】PUT 必须识别脱敏串，否则"保存一次清空 Key"
    ok(`${name} PUT 识别脱敏串并保留原 Key（防保存即清空）`,
      /zhipuKey[\s\S]{0,200}\*\*\*\*/.test(src) || /looksMasked/.test(src))
  }

  // 权限键三处一致
  const fPerm = readFileSync(`${ROOT}/src/constants/permissions.ts`, 'utf8')
  ok("ai_settings 在 worker PERM_KEYS 中", /'ai_settings'/.test(worker))
  ok("ai_settings 在 server/auth.ts PERM_KEYS 中",
    /'ai_settings'/.test(readFileSync(`${ROOT}/server/auth.ts`, 'utf8')))
  ok('ai_settings 在前端权限常量中', /'ai_settings'/.test(fPerm))
  ok('ai_settings 有中文标签', /ai_settings:\s*'AI 设置'/.test(fPerm))

  // 菜单与路由
  const layout = readFileSync(`${ROOT}/src/layouts/AdminLayout.vue`, 'utf8')
  const router = readFileSync(`${ROOT}/src/router/index.ts`, 'utf8')
  ok('后台菜单含 AI 设置入口', /admin-ai-settings/.test(layout) && /ai_settings/.test(layout))
  ok('路由注册了 AI 设置页', /admin-ai-settings/.test(router))

  // ── 铁律#11 的延伸：字段不能漂移 ────────────────────────────────────────
  //   共享模块 AiEnv 的每个字段，两端都必须能注入进来；少一个就会出现
  //   「本地能跑、线上不生效」这种极难排查的问题（v4.12.0 实测踩到过：
  //   AI_BASE_* 忘了在 readAiEnv 里转发，mock 收不到请求）。
  const aiEnvFields = [...shared.matchAll(/^  ([A-Z][A-Z_0-9]*)\??:/gm)]
    .map(m => m[1])
    .filter((f, i, a) => a.indexOf(f) === i && /AI|ZHIPU|PROVIDER|MODEL|BASE/.test(f))
  const missingWorker = aiEnvFields.filter(f => !worker.includes(f))
  const missingLocal = aiEnvFields.filter(f => !local.includes(f))
  ok(`⚠️ 共享模块的每个 AiEnv 字段都被 worker 注入（防字段漂移，共 ${aiEnvFields.length} 个）`,
    missingWorker.length === 0, `worker 缺: ${missingWorker.join(',')}`)
  ok('⚠️ 共享模块的每个 AiEnv 字段都被 server 注入（防字段漂移）',
    missingLocal.length === 0, `server 缺: ${missingLocal.join(',')}`)

  console.log('\n=== 6. 共享模块的关键设计 ===')
  ok('双通道都实现：callCfAi + callZhipu',
    /async function callCfAi/.test(shared) && /async function callZhipu/.test(shared))
  ok('⭐ 已彻底移除 Gemini 实现（用户否决）', !/async function callGemini/.test(shared))
  ok('⭐ 默认不再依赖任何 Google 密钥字段', !/GEMINI_API_KEY/.test(shared))
  ok('auto 模式默认顺序 CF → 智谱',
    /mode === 'cf' \? \['cf'\]/.test(shared) && /\['cf', 'zhipu'\]/.test(shared))
  ok('一个通道失败自动切换另一个（for 循环 attempts）', /for \(const p of order\)/.test(shared))
  ok('⚠️ CF 通道内部还做「主力模型 → 备用模型」的模型级降级',
    /const models = primary === fallback \? \[primary\] : \[primary, fallback\]/.test(shared))
  ok('CF 通道支持绑定路径（env.AI.run，零密钥）',
    /env\.AI && typeof env\.AI\.run === 'function'/.test(shared))
  ok('CF 通道保留 REST 路径（本地开发可测）', /ai\/run\/\$\{model\}/.test(shared))
  ok('关闭思维链以省神经元（enable_thinking:false）',
    /enable_thinking:\s*false/.test(shared))
  ok('两通道都有超时控制（AbortController 或 withTimeout）',
    (shared.match(/AbortController/g) || []).length >= 1 && /function withTimeout/.test(shared))
  ok('prompt 明确要求「卷末参考答案回填到题目」（正则做不到的关键点）',
    /卷末如果有独立的「参考答案」/.test(shared))
  ok('prompt 明确「content 不含选项/答案/解析」（避免内容重复输出）',
    /content 里\*\*不要包含\*\*选项、答案、解析/.test(shared))
  ok('prompt 明确「不要编造答案」', /不要编造/.test(shared))
  ok('⚠️ prompt 显式给出英文 JSON 骨架（防模型漂移成中文键名）',
    /必须严格使用下列英文键名/.test(shared))
  ok('⚠️ prompt 显式要求 options 必须是数组（模型爱给对象）',
    /options \*\*必须是字符串数组\*\*/.test(shared))
  ok('温度压到 0.1（结构化抽取要稳）', /temperature: 0\.1/.test(shared))

  // 模型选择：必须是实测在免费额度内可用的
  ok('默认主力模型是 GLM-4.7-Flash（中文最强 + 最省）',
    DEFAULT_MODEL_CF === '@cf/zai-org/glm-4.7-flash', DEFAULT_MODEL_CF)
  ok('备用模型是 Llama-3.3-70B（JSON 最规范）',
    /DEFAULT_MODEL_CF_FALLBACK = '@cf\/meta\/llama-3\.3-70b-instruct-fp8-fast'/.test(shared))
  ok('候选模型清单已导出（供后台下拉）', /export const CF_MODEL_CHOICES/.test(shared))

  // wrangler.toml 配置
  const wrangler = readFileSync(`${ROOT}/wrangler.toml`, 'utf8')
  ok('⭐ wrangler.toml 配置了 [ai] 绑定（零密钥的关键）',
    /\[ai\][\s\S]{0,80}binding = "AI"/.test(wrangler), wrangler.match(/\[ai\][\s\S]{0,80}/)?.[0] || '未找到')
  ok('wrangler.toml 已移除 GEMINI 变量', !/GEMINI/.test(wrangler))
  ok('wrangler.toml 配置了 AI_MODEL_CF', /AI_MODEL_CF\s*=/.test(wrangler))

  console.log(`\n${'─'.repeat(52)}`)
  console.log(`结果：${pass} 项通过 / ${fail} 项失败`)
  if (fail) { console.log('❌ AI 试卷识别不变量被破坏'); process.exit(1) }
  console.log('✅ AI 试卷识别全部不变量成立')
} finally {
  await server.close()
}
