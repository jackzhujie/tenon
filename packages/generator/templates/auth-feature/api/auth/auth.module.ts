import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { TypeOrmModule } from '@nestjs/typeorm'
import { AuthSession } from './auth-session.entity'
import { AuthUser } from './auth-user.entity'
import { AuthController } from './auth.controller'
import { AuthGuard } from './auth.guard'
import { AuthService } from './auth.service'

/**
 * 账号模块。它做三件事：注册两张表、挂上接口、**装上那把全局守卫**。
 *
 * ★ 守卫用 `APP_GUARD` 注册成全局的，不是挂在控制器上。挂在控制器上只保护这个
 *   控制器里的接口，而用户（或 Agent）新加的接口默认是不受保护的 —— 那种"看起来
 *   有鉴权"的状态比完全没有更危险。放行的唯一方式是 `@Public()`。
 *
 * ★ 这个模块不能被删。删了之后应用照常启动、页面照常打开，只是所有接口都公开了。
 */
@Module({
  imports: [TypeOrmModule.forFeature([AuthUser, AuthSession])],
  controllers: [AuthController],
  providers: [
    AuthService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
