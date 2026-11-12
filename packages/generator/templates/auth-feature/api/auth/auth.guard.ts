/**
 * 全局守卫：**默认拒绝**。
 *
 * 为什么默认拒绝而不是默认放行：默认放行时，每加一个接口都要记得"加守卫"，
 * 而忘记的表现是**一切正常** —— 只是那个接口谁都能调。这类漏洞不会在开发时暴露，
 * 也不会在测试里失败，只会在某天被人发现数据被改过。
 *
 * 放行的唯一方式是显式 `@Public()`（见 `public.decorator.ts`），于是"哪些接口是
 * 公开的"永远是一个能 grep 全的清单。
 *
 * ★ 唯一的例外是就绪探针（`GET /api/health`），它在这里**硬编码放行**，不走 `@Public()`。
 *   两件事的"谁能改"不一样：`@Public()` 是应用内的约定（用户随时可能改），而
 *   `/api/health` 是平台契约（网关的就绪判定写死了这条路径，见 `gateway/src/preview.ts`）。
 *   实测过一次漏掉它的后果：预览 300 秒超时，日志里只有一串
 *   `4xx GET /api/health → 401`，看起来像后端崩了，而真因是守卫。
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { AUTH_COOKIE_NAME } from './cookie-name'
import { readCookie } from './cookies'
import { IS_PUBLIC } from './public.decorator'
import { AuthService, type SessionUser } from './auth.service'

/** 守卫把用户挂在请求上，`@CurrentUser()` 从这儿取 */
export interface AuthedRequest extends Request {
  user?: SessionUser
}

/** 平台的就绪探针。带不带全局前缀两种写法都认，见文件头的说明 */
function isReadinessProbe(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const path = (request.originalUrl ?? request.url ?? '').split('?')[0] ?? ''
  return path === '/api/health' || path === '/health'
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>()
    // 先放行探针：这一步不查库，守卫挂掉也不该让"后端起没起来"变成不可观测
    if (isReadinessProbe(request)) return true

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic === true) return true

    const token = readCookie(request.headers.cookie, AUTH_COOKIE_NAME)
    if (token === null) throw new UnauthorizedException('sign-in required')

    const user = await this.auth.resolve(token)
    if (user === null) throw new UnauthorizedException('the session has expired; sign in again')

    request.user = user
    return true
  }
}
