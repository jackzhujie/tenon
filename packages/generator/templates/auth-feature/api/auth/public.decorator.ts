/**
 * 「这个接口不需要登录」的唯一写法。
 *
 * 全局守卫（`AuthGuard`）默认拒绝一切。想放行就挂 `@Public()`，**没有别的口子**
 * —— 这样"哪些接口是公开的"永远是一个能用 grep 找全的清单。
 *
 * 反过来做（默认放行、逐个加守卫）一定会漏，而且漏掉的那个接口和旁边的长得一模一样。
 */
import { SetMetadata } from '@nestjs/common'

export const IS_PUBLIC = 'tenon:auth:public'

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true)
