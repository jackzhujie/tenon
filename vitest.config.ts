import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // 端口/文件系统都在用，串行更稳，也便于定位失败
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 断言写的是产品原本的中文措辞（见 test/setup.ts 里的理由）
    setupFiles: ['./test/setup.ts'],
  },
})
