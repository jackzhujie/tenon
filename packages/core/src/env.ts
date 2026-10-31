/**
 * 环境变量清洗。
 *
 * 有两处会「把我们进程的环境变量交给别人的代码」：
 * 1. Agent 的 bash 工具（`packages/agent/src/tools/coding.ts`）
 * 2. 预览时拉起生成应用的 dev server（`packages/gateway`）
 *
 * 第二次出现这条需求时就该挪到一处了 —— 两份实现早晚会漂移成两套规则，
 * 而这类漂移的表现是「某个密钥从另一条路径漏出去」，不是报错。
 *
 * `TENON_*` 一定剥掉：`TENON_HOME` / `TENON_FAUX` 之类会把服务端的运行方式
 * 泄漏给生成应用，而生成应用是要能被导出、分享的。
 */
const SECRETISH = /(?:api[_-]?key|secret|token|password|passwd|credential|authorization)/i

export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (key.startsWith('TENON_')) continue
    // 桌面版用它把 Electron 的可执行文件当 node 跑；漏给生成应用没有任何好处，
    // 却会让「子进程里再起一个 electron」变成静默的"当 node 跑了"
    if (key === 'ELECTRON_RUN_AS_NODE') continue
    if (SECRETISH.test(key)) continue
    out[key] = value
  }
  return out
}
