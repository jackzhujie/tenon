import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // 端口/文件系统都在用，串行更稳，也便于定位失败
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
