import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setLocale } from '@tenon/protocol/locale'
import { App } from './app/App.js'
import { cacheLocale, detectLocale, I18nProvider, isLocale, readCachedLocale, type Locale } from './lib/i18n.js'
import { rpc } from './lib/rpc.js'
import './styles/global.css'

const container = document.getElementById('root')
// 开发者错误：这不是给用户看的文案，不进翻译表
if (container === null) throw new Error('#root is missing — index.html was modified')

/**
 * 语言在**渲染之前**定下来，而不是渲染后再纠正。
 *
 * 三条来源按可信度排：服务端存的选择 > 本机缓存 > 系统语言（认不出来时英文兜底）。
 * 先 await 一次 `settings.get` 再 render，换来的是**不会闪** —— 否则中文系统上设过英文的人，
 * 每次启动都会先看到一屏中文再跳成英文，比慢这十几毫秒难看得多。
 *
 * 服务端没起来时 `catch` 兜住：这时候用系统语言是对的，因为连不上服务本身马上会显示错误条。
 */
async function resolveLocale(): Promise<Locale> {
  try {
    const { values } = await rpc('settings.get', {})
    const saved = values['ui.locale']
    if (isLocale(saved)) return saved
  } catch {
    // 服务尚未就绪：下面用缓存/系统语言，App 自己会把连接错误显示出来
  }
  return readCachedLocale() ?? detectLocale()
}

async function boot(): Promise<void> {
  const initial = await resolveLocale()
  cacheLocale(initial)
  /*
   * 先把语言写进协议层，**再 render**：`lib/rpc.ts` 的网络错误是模块级代码，
   * 它读的是同一个值。等 Provider 的 effect 再写，第一屏里发生的错误会用默认英文。
   */
  setLocale(initial)

  createRoot(container!).render(
    <StrictMode>
      <I18nProvider
        initial={initial}
        onLocaleChange={(locale) => {
          // 写失败不回滚界面：语言是本地偏好，下次启动会以服务端为准
          void rpc('settings.set', { values: { 'ui.locale': locale } }).catch(() => undefined)
        }}
      >
        <App />
      </I18nProvider>
    </StrictMode>,
  )
}

void boot()
