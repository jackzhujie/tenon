/**
 * Tenon 自己的 lint 配置（flat config，ESLint 10）。
 *
 * **这份和生成应用那份（`packages/generator/templates/*`）刻意不是同一份。**
 * 那份只留三条规则，因为 Agent 生成的代码是从零开始、量也小，规则一多就会"写一次红一次"，
 * 而**被关掉的检查等于不存在**。这份是本仓库自己一行行写的代码，可以宽一些 ——
 * 但也只宽到"能长期绿"为止：**常年红的检查同样等于不存在**。
 *
 * 三条例外都是踩过之后才关的，理由写在下面，别随手打开。
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-server/**',
      // Electron 打包产物（`electron-builder --dir` 出来的 .app）
      'apps/desktop/release/**',
      /*
       * 逆向研究材料。里面有几百个**压缩过**的 .js（`ide-dump` / `builder-dump`），
       * 不排除的话一次 lint 会报 **67590** 个问题 —— 99% 来自这里。
       * 它已经进了 .gitignore，但磁盘上还在，所以这里也得挡。
       */
      'docs/reverse/**',
      // `pnpm build:plugins` 的产物：三个 735KB 的单文件 bundle
      'plugins/bundled/*/web.js',
      'plugins/bundled/*/server.js',
      /*
       * 模板是**给生成应用的文件**，由模板自己的 `eslint.config.mjs` 管。
       * 而且里面还有 `{{appName}}` 占位符 —— 在 JSX 里语法合法，但那是待替换的文本，
       * lint 它没有意义。
       */
      'packages/generator/templates/**',
      '**/*.d.ts',
      /*
       * 只管 TypeScript。`.mjs` 只有几个构建脚本（`apps/desktop/build.mjs`、
       * `scripts/*.mjs`），给它们配一套 node globals 才能消掉 `process is not defined`，
       * 而那些文件的价值远低于这份配置的复杂度。**如实记：它们目前没有 lint。**
       */
      '**/*.js',
      '**/*.mjs',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      /*
       * TypeScript 自己就管未定义标识符（且有完整的类型信息）。这条对 .ts 是纯噪声 ——
       * 它只能靠 globals 白名单猜，而我们又没有 `@types/node` 那种覆盖。
       */
      'no-undef': 'off',
      /*
       * 探到的 15 处**全是同一种写法**：给 `let` 一个初值以满足 TS 的确定性赋值分析。
       *
       *   let last = ''
       *   for (;;) { try { ... last = ... } catch { last = ... }
       *              if (deadline) throw new Error(`等不到：${last}`) }
       *
       * 初值确实会被覆盖，但**去掉它 tsc 会报"使用前未赋值"**（编译器分析不了
       * `for(;;)` 一定进循环）。所以这条规则在这个项目里只会产出"正确的抱怨"。
       */
      'no-useless-assignment': 'off',
      // 本项目已经在用 `_` 前缀表达"我知道它不用"（`{ _props }`、`catch (_e)`）
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      /*
       * react-hooks v7 新加的性能建议："effect 里同步 setState 会触发级联渲染"。
       * 7 个面板都是 `useEffect(() => { setLoading(true); void load() })` 这个模式 ——
       * 值得知道，但不该拦发布。设 warn：留在输出里，不进退出码。
       */
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
)
