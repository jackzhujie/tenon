/**
 * 传输层约定（DESIGN §7.4）。**本文件刻意零依赖** —— 它是浏览器能够 import 的最小面。
 *
 * 为什么单独拆出来：前端只需要路径和头名两个常量，可它一旦从包的主入口拿，
 * 整张 zod 校验表（rpc.ts / events.ts / domain.ts 的 `z.object` 都在模块顶层求值）
 * 就会被 rollup 一并打进产物 —— 那部分副作用无法被 tree-shake 掉。
 * 实测：拆之前 Web 产物 356KB / 146 个模块，拆之后 256KB / 48 个模块（gzip 109KB → 80KB）。
 *
 * 服务端也必须从这里取路径，不允许在 `app.ts` 里手写 '/rpc/' 之类的字面量：
 * 两边各写一份的结果是「改了常量、测试还是绿的、前端 404」。
 */

/** RPC 走 `POST /rpc/<method>`，body 即入参；事件走 `GET /events?appId&since` */
export const TRANSPORT = {
  rpcPathPrefix: '/rpc/',
  eventsPath: '/events',
  healthPath: '/api/health',
  /** 渲染器与本机 server 之间唯一的凭证头 */
  tokenHeader: 'authorization',
} as const
