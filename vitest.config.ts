import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `scripts/test/` 是门禁脚本自己的护栏：它们错了只会让门禁变绿，没人能发现
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'scripts/test/**/*.test.ts',
    ],
    // 端口/文件系统都在用，串行更稳，也便于定位失败
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 断言写的是产品原本的中文措辞（见 test/setup.ts 里的理由）
    setupFiles: ['./test/setup.ts'],
  },
})
