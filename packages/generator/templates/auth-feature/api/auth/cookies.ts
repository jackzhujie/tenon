/**
 * cookie 的读与写。
 *
 * 为什么不用 `cookie-parser`：这里只需要「按名字取一个值」和「写一个 Set-Cookie」，
 * 两个十几行的函数。多一个依赖就要多一次 install、多一个版本约束，而且 Express 的
 * 中间件注册顺序又会变成一个"必须记住"的约定。
 *
 * ★ 只 `HttpOnly` 是不够的：`SameSite=Lax` 才是挡住 CSRF 的那一条 —— 跨站 POST
 *   不会带上这个 cookie。`Secure` 按请求是否走 https 决定（本地预览是 http，
 *   部署到 https 后面自动加上），写死任一个都会在另一半场景里出错。
 */
import type { Request, Response } from 'express'

export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined || header === '') return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() !== name) continue
    return decodeURIComponent(part.slice(index + 1).trim())
  }
  return null
}

function isSecure(req: Request): boolean {
  return req.secure || req.headers['x-forwarded-proto'] === 'https'
}

export function setSessionCookie(
  req: Request,
  res: Response,
  name: string,
  token: string,
  maxAgeSeconds: number,
): void {
  const parts = [
    `${name}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ]
  if (isSecure(req)) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

export function clearSessionCookie(req: Request, res: Response, name: string): void {
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (isSecure(req)) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}
