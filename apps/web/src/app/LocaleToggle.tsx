/**
 * 语言切换。放顶栏而不是设置里：它是**一眼能看到的偏好**，
 * 而且第一次打开时英文界面的人不需要先找到设置再找语言。
 *
 * 按钮上写的是"切过去之后会看到什么"（当前英文时显示「中」），
 * 这样点一下的结果是可预期的 —— 写当前语言会让人以为是状态标签。
 */
import { useT } from '../lib/i18n.js'

export function LocaleToggle() {
  const { locale, setLocale, t } = useT()
  const next = locale === 'zh' ? 'en' : 'zh'
  return (
    <button
      type="button"
      data-locale-toggle=""
      onClick={() => setLocale(next)}
      title={t('locale.switch')}
      className="rounded-md border border-line bg-panel-2 px-1.5 py-0.5 text-[10.5px] text-muted hover:text-ink"
    >
      {/* i18n-ignore 语言代号本身不翻译：英文界面显示「中」，中文界面显示「EN」 */}
      {next === 'en' ? 'EN' : '中'}
    </button>
  )
}
