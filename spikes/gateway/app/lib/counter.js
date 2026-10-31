// 被 HMR 观察的模块：改这个文件的 counter 值，Vite 应当推送 type=update
export const counter = 1

export function render(target) {
  target.innerHTML = `<h1>计数：${counter}</h1><p>这一段来自 /lib/counter.js</p>`
}
