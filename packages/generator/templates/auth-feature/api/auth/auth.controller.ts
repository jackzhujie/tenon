/**
 * 账号接口。
 *
 * 五个公开、三个要管理员 —— 公开的那几个必须写 `@Public()`，否则全局守卫会拦。
 * 公开清单（全部都是"没有账号之前就得能用"的）：status / setup / login / logout。
 *
 * ★ `status` 特意做成**公开且永远 200**：前端每次加载都要问"我是谁"，
 *   如果它用 `/me`（未登录 401），日志面板每开一次页面就多一条 4xx ——
 *   用户会以为应用在报错。语义上"未登录"也不是错误。
 */
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import {
  LoginInput,
  NewUserInput,
  PasswordInput,
  SetupInput,
  type SessionUser,
} from '../../shared/auth-schema'
import { AUTH_COOKIE_NAME } from './cookie-name'
import { clearSessionCookie, readCookie, setSessionCookie } from './cookies'
import { CurrentUser } from './current-user.decorator'
import { Public } from './public.decorator'
import { AuthService, secondsUntil } from './auth.service'
import { parseBody } from './validate'

function requireAdmin(user: SessionUser): void {
  if (user.role !== 'admin') throw new ForbiddenException('只有管理员能做这件事')
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** 前端加载时问一次：要不要初始化、现在是谁。**永远 200** */
  @Public()
  @Get('status')
  async status(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ needsSetup: boolean; user: SessionUser | null }> {
    const token = readCookie(req.headers.cookie, AUTH_COOKIE_NAME)
    const user = token === null ? null : await this.auth.resolve(token)
    // 令牌过期了就把 cookie 擦掉，免得每次请求都带着一个永远无效的值
    if (token !== null && user === null) clearSessionCookie(req, res, AUTH_COOKIE_NAME)
    return { needsSetup: await this.auth.needsSetup(), user }
  }

  /** 初始化第一个管理员。库里有账号之后自动关闭（见 AuthService.setup） */
  @Public()
  @Post('setup')
  async setup(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: SessionUser }> {
    const input = parseBody(SetupInput, body)
    const user = await this.auth.setup(input.email, input.password)
    const session = await this.auth.issueSession(user.id)
    setSessionCookie(req, res, AUTH_COOKIE_NAME, session.token, secondsUntil(session.expiresAt))
    return { user }
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: SessionUser }> {
    const input = parseBody(LoginInput, body)
    const user = await this.auth.verify(input.email, input.password)
    if (user === null) {
      /*
       * 不区分"邮箱不存在"和"密码不对"：分开说等于提供一个账号枚举接口。
       * 同一个 401 再加上 `verify` 里的等价耗时（见 AuthService.verify），
       * "谁在这个系统里有账号"就不再是能问出来的信息。
       */
      throw new ForbiddenException('邮箱或密码不对')
    }
    const session = await this.auth.issueSession(user.id)
    setSessionCookie(req, res, AUTH_COOKIE_NAME, session.token, secondsUntil(session.expiresAt))
    return { user }
  }

  /** 退出：公开（没登录也能调，幂等），顺手把 cookie 擦掉 */
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = readCookie(req.headers.cookie, AUTH_COOKIE_NAME)
    if (token !== null) await this.auth.revoke(token)
    clearSessionCookie(req, res, AUTH_COOKIE_NAME)
  }

  /** 当前用户（未登录 401 —— 给"必须先确定身份才能继续"的调用方用） */
  @Get('me')
  me(@CurrentUser() user: SessionUser): SessionUser {
    return user
  }

  @Get('users')
  async list(@CurrentUser() user: SessionUser): Promise<{ users: SessionUser[] }> {
    requireAdmin(user)
    return { users: await this.auth.list() }
  }

  @Post('users')
  @HttpCode(201)
  async create(
    @CurrentUser() actor: SessionUser,
    @Body() body: unknown,
  ): Promise<{ user: SessionUser }> {
    requireAdmin(actor)
    const input = parseBody(NewUserInput, body)
    return { user: await this.auth.createUser(input.email, input.password, input.role) }
  }

  @Delete('users/:id')
  @HttpCode(204)
  async remove(
    @CurrentUser() actor: SessionUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    requireAdmin(actor)
    await this.auth.remove(actor, id)
  }

  /** 改自己的口令 */
  @Post('password')
  @HttpCode(204)
  async changePassword(
    @CurrentUser() actor: SessionUser,
    @Body() body: unknown,
  ): Promise<void> {
    const input = parseBody(PasswordInput, body)
    await this.auth.changePassword(actor, input.current, input.next)
  }
}
