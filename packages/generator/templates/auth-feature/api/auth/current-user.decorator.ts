/**
 * 取当前登录用户。
 *
 * 用法：
 * ```ts
 * @Get('orders')
 * list(@CurrentUser() user: SessionUser) { return this.orders.listFor(user.id) }
 * ```
 *
 * 守卫已经把用户放进请求里了，这个装饰器只是把它取出来 —— 但**不要**因此在
 * controller 里手写 `req.user!`：那会在"忘了给接口加守卫"时静默拿到 undefined，
 * 而这里会直接抛（带着一句说得清的提示）。
 */
import { createParamDecorator, UnauthorizedException } from '@nestjs/common'
import type { ExecutionContext } from '@nestjs/common'
import type { AuthedRequest } from './auth.guard'
import type { SessionUser } from './auth.service'

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionUser => {
    const request = context.switchToHttp().getRequest<AuthedRequest>()
    if (request.user === undefined) {
      throw new UnauthorizedException('这个接口需要登录（守卫没跑？检查 AuthModule 是否还在 imports 里）')
    }
    return request.user
  },
)
