/**
 * 生成应用的 lint 配置（flat config，ESLint 10）。
 *
 * **规则刻意只有三条。** 这不是"还没配完"，是设计：
 *
 * 1. 这个应用是 Agent 一行行写出来的，如果开 `recommended` 全家桶
 *    （`no-explicit-any` / `no-non-null-assertion` / 各种风格规则），
 *    **每一次生成都会红**。红的次数一多，用户就会去关掉 lint ——
 *    而一个被关掉的检查等于不存在，还不如一开始就不加。
 * 2. 所以只留三种"确实是 bug"的：
 *    - 未使用的变量：常常是"改到一半"的证据（旧的实现没删干净）
 *    - 条件里调 hook：真会在运行时炸（hook 顺序变了）
 *    - 依赖数组漏项：**只警告不拦**（`exhaustive-deps` 误报太多，见下）
 * 3. 风格问题（引号、分号、缩进）不在这里管。那是 formatter 的事，
 *    而且 Agent 的产出本来就不保证风格一致 —— 拦它只会制造噪声。
 *
 * 需要更严的时候自己往上加：这份配置是**你的**，不是 Tenon 的。
 */
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks,
    },
    rules: {
      /*
       * 下划线开头的名字视为"我知道它没用"：`{ _props }`、`catch (_e)` 是明确表态，
       * 不该和"忘了删"报成同一件事。
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'react-hooks/rules-of-hooks': 'error',
      /*
       * 只警告。生成代码里"我就要用一次当时的值"很常见，而这在语义上未必是 bug；
       * 设成 error 会让它成为最常见的发布拦路石，然后整个 lint 被关掉。
       */
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
]
