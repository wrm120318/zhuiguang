// v4.10.0 Word 导出端到端探针 · 驱动脚本
// 用法：node scripts/probe-docx-e2e.mjs
//
// ⚠️ 断言写在 probe-docx-e2e.entry.ts，由 vite ssrLoadModule 加载，
//    以保证与 docx-kit 共享同一个 docx 模块实例（否则序列化退化）。
import { createServer } from 'vite'

const server = await createServer({
  root: '/workspace/zhuiguang',
  logLevel: 'error',
  server: { middlewareMode: true },
  appType: 'custom',
})

try {
  const mod = await server.ssrLoadModule('/scripts/probe-docx-e2e.entry.ts')
  const { fail } = await mod.run()
  await server.close()
  process.exit(fail ? 1 : 0)
} catch (e) {
  console.error('探针执行异常：', e)
  await server.close()
  process.exit(1)
}
