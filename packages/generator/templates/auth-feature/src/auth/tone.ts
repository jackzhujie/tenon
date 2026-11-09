/**
 * 登录界面跟随**这个应用自己的底色**，而不是跟随系统偏好。
 *
 * 为什么：生成应用的配色是 Agent 按需求做的（模板默认是浅色），与用户系统是深色
 * 完全无关。只写 `@media (prefers-color-scheme: dark)` 会出现"浅色页面 + 黑色弹层"
 * 和"白色登录卡片压在深色应用上"—— 两种都像贴错了图。
 *
 * 做法：读 `body`（拿不到就 `html`）的**实际背景色**算亮度，一次定调。不监听变化 ——
 * 应用在运行时切换主题属于它自己的事，登录界面下一次挂载会重新判断。
 */
export type Tone = 'light' | 'dark'

/** `rgb()` / `rgba()` → 0..1 的亮度；透明或解析不了返回 null（继续往上找） */
function luminance(color: string): number | null {
  const match = /rgba?\(([^)]+)\)/.exec(color)
  if (match === null) return null
  const parts = (match[1] ?? '').split(',').map((value) => Number(value.trim()))
  const [r, g, b, a] = parts
  if (r === undefined || g === undefined || b === undefined) return null
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null
  // 完全透明等于"没铺底色"，交给下一个元素
  if (a !== undefined && a === 0) return null
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

export function detectTone(): Tone {
  if (typeof document === 'undefined') return 'light'
  for (const element of [document.body, document.documentElement]) {
    const value = luminance(window.getComputedStyle(element).backgroundColor)
    if (value !== null) return value < 0.5 ? 'dark' : 'light'
  }
  return 'light'
}
