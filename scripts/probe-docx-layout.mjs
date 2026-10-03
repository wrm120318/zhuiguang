// v4.10.0 Word 导出排版探针 · 驱动脚本
//
// 用法：node scripts/probe-docx-layout.mjs
//
// ⚠️ 真正的断言写在 `probe-docx-layout.entry.ts`，由本脚本用 vite 的
//    `ssrLoadModule()` 加载。这样做的唯一目的是**保证 docx 只有一份模块实例**
//    （详见 entry.ts 顶部注释：两份实例会让 docx 序列化退化成 `<rootKey>`）。
import { createServer } from 'vite'

const server = await createServer({
  root: '/workspace/zhuiguang',
  logLevel: 'error',
  server: { middlewareMode: true },
  appType: 'custom',
})

try {
  const mod = await server.ssrLoadModule('/scripts/probe-docx-layout.entry.ts')
  const { fail } = await mod.run()
  await server.close()
  process.exit(fail ? 1 : 0)
} catch (e) {
  console.error('探针执行异常：', e)
  await server.close()
  process.exit(1)
}
