/**
 * 模型设置（M5.5）：让"填个 key 就能用"这条路在界面上真的存在。
 *
 * 做之前的状况：`provider.upsert` 有 RPC、**没有界面**，而且模型只在启动时解析一次。
 * 也就是说这个产品的 BYOK 只对写脚本的人可用 —— 真用户拿到 API Key 也没处填。
 *
 * 三个刻意的取舍：
 * 1. **保存后立刻生效**（后端热切换），不在界面上留一句"重启后生效"。后者是让自己
 *    免责、把成本转给用户的做法；真做不了才这么说。
 * 2. **测试连接单独一个按钮**。填错 key 的表现和"模型有点笨"几乎一样，
 *    用户会以为是产品不好用。测一次，把提供商的原话（401 / 404）直接摆出来。
 * 3. **密钥只写不读**。列表里只有"已配置 / 未配置"；编辑时留空 = 不改。反显明文
 *    没有任何必要，而它会多出一条泄漏路径。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ModelPrice, ProviderProfile } from '@tenon/protocol'
import { rpc } from '../../lib/rpc.js'
import { cn } from '../../lib/cn.js'
import { useT } from '../../lib/i18n.js'
import type { ActiveModel } from '../../hooks/useWorkspace.js'

interface ModelState {
  model: { mode: string; providerId: string; modelId: string } | null
  error: string | null
  changed: boolean
}

interface Form {
  id?: string
  label: string
  baseUrl: string
  modelId: string
  apiKey: string
}

/**
 * 价格表单。**单位是美元 / 百万 token** —— 与账单上的写法一致，
 * 不做"每千 token"这种换算：换算错一次就是三个数量级的账，而没人会察觉。
 */
interface PriceForm {
  profileId: string
  priceId?: string
  modelId: string
  input: string
  output: string
}

const EMPTY_FORM: Form = { label: '', baseUrl: 'https://api.openai.com/v1', modelId: '', apiKey: '' }

/** 常见端点做成快捷键：没有它，90% 的人会在 baseUrl 上写错（漏 /v1 或多写 /chat/completions） */
const PRESETS: { label: string; baseUrl: string; modelId: string }[] = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-chat' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-4o-mini' },
  { label: 'Local LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', modelId: 'local-model' },
]

export interface ModelPanelProps {
  /** 顶栏已经知道的当前模型（workspace 的 boot health）—— 不在这里重复算一份 */
  model: ActiveModel | null
  /** 保存/启用/删除之后通知外面刷新，顶栏标签立刻跟上 */
  onChanged(): Promise<void> | void
}

export function ModelPanel({ model, onChanged }: ModelPanelProps) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [profiles, setProfiles] = useState<ProviderProfile[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [prices, setPrices] = useState<ModelPrice[]>([])
  const [priceForm, setPriceForm] = useState<PriceForm | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [list, settings, priceList] = await Promise.all([
        rpc('provider.list', {}),
        rpc('settings.get', {}),
        rpc('price.list', {}),
      ])
      setProfiles(list.profiles)
      setPrices(priceList.prices)
      const selected = settings.values['agent.activeProviderId']
      setActiveId(typeof selected === 'string' ? selected : null)
    } catch (err) {
      setNotice({ tone: 'bad', text: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  /** 把后端回的 applied 翻译成一句人话 —— 这是用户最关心的"现在能用了吗" */
  function report(applied: ModelState): void {
    if (applied.model === null) {
      setNotice({ tone: 'bad', text: applied.error ?? t('model.notice.saveFailed') })
      return
    }
    setNotice({
      tone: 'ok',
      text: applied.changed
        ? t('model.notice.applied', { model: applied.model.modelId })
        : t('model.notice.unchanged', { model: applied.model.modelId }),
    })
  }

  async function save(): Promise<void> {
    if (form === null) return
    if (form.label.trim() === '' || form.modelId.trim() === '') {
      setNotice({ tone: 'bad', text: t('model.error.nameAndId') })
      return
    }
    setBusy('save')
    try {
      const saved = await rpc('provider.upsert', {
        ...(form.id === undefined ? {} : { id: form.id }),
        label: form.label.trim(),
        kind: 'openai-compatible',
        baseUrl: form.baseUrl.trim(),
        tier: 'auto',
        modelId: form.modelId.trim(),
        paramsJson: null,
        // 编辑时留空 = 保留原密钥（后端也是这个语义，这里显式传 null 更清楚）
        apiKey: form.apiKey.trim() === '' ? null : form.apiKey.trim(),
      })
      report(saved.applied)
      setForm(null)
      await Promise.all([load(), Promise.resolve(onChanged())])
    } catch (err) {
      setNotice({ tone: 'bad', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  async function savePrice(): Promise<void> {
    if (priceForm === null) return
    const input = Number(priceForm.input)
    const output = Number(priceForm.output)
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
      setNotice({ tone: 'bad', text: t('model.error.price') })
      return
    }
    setBusy('price')
    try {
      const saved = await rpc('price.set', {
        profileId: priceForm.profileId,
        modelId: priceForm.modelId.trim(),
        inputPerMTok: input,
        outputPerMTok: output,
        cacheReadPerMTok: 0,
        cacheWritePerMTok: 0,
      })
      report(saved.applied)
      setPriceForm(null)
      await Promise.all([load(), Promise.resolve(onChanged())])
    } catch (err) {
      setNotice({ tone: 'bad', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  async function removePrice(price: ModelPrice): Promise<void> {
    setBusy(`price:${price.id}`)
    try {
      const removed = await rpc('price.remove', { id: price.id })
      report(removed.applied)
      await Promise.all([load(), Promise.resolve(onChanged())])
    } catch (err) {
      setNotice({ tone: 'bad', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  async function test(profile: ProviderProfile): Promise<void> {
    setBusy(`test:${profile.id}`)
    try {
      const result = await rpc('provider.test', { id: profile.id })
      setNotice({
        tone: result.ok ? 'ok' : 'bad',
        text: result.ok ? `${result.message}（${result.latencyMs}ms）` : result.message,
      })
    } catch (err) {
      setNotice({ tone: 'bad', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  async function activate(profile: ProviderProfile): Promise<void> {
    setBusy(`use:${profile.id}`)
    try {
      const saved = await rpc('settings.set', { values: { 'agent.activeProviderId': profile.id } })
      report(saved.applied)
      await Promise.all([load(), Promise.resolve(onChanged())])
    } catch (err) {
      setNotice({ tone: 'bad', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  async function remove(profile: ProviderProfile): Promise<void> {
    setBusy(`del:${profile.id}`)
    try {
      const removed = await rpc('provider.delete', { id: profile.id })
      report(removed.applied)
      await Promise.all([load(), Promise.resolve(onChanged())])
    } catch (err) {
      setNotice({ tone: 'bad', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  const configured = model !== null

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'rounded-md border px-2 py-1 text-[11px]',
          configured
            ? 'border-line bg-panel-2 text-muted hover:text-ink'
            : 'border-warn/50 bg-warn/10 text-warn',
        )}
        title={
      configured
        ? t('model.tip.configured', { model: model.modelId })
        : t('model.tip.unconfigured')
    }
      >
        {configured ? (model.mode === 'faux' ? t('model.faux') : model.modelId) : t('model.unconfigured')}
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-50 w-[460px] rounded-lg border border-line bg-panel p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12px] text-ink">{t('model.title')}</span>
            <span className="font-mono text-[10px] text-faint">
              {configured ? `${model.mode} · ${model.providerId}` : t('model.unconfigured')}
            </span>
          </div>

          {notice !== null && (
            <p className={cn('mb-2 text-[11px]', notice.tone === 'ok' ? 'text-ok' : 'text-bad')}>
              {notice.text}
            </p>
          )}

          {profiles.length === 0 && form === null && (
            <p className="mb-2 text-[11px] text-faint">
              {t('model.empty.providers')}
            </p>
          )}

          <ul className="mb-2 flex flex-col gap-2">
            {profiles.map((profile) => (
              <li key={profile.id} className="rounded-md border border-line bg-panel-2 p-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[12px] text-ink">{profile.label}</span>
                      {activeId === profile.id && (
                        <span className="rounded border border-ok/40 px-1 text-[9.5px] text-ok">{t('model.badge.current')}</span>
                      )}
                      {!profile.hasApiKey && (
                        <span className="rounded border border-warn/40 px-1 text-[9.5px] text-warn">{t('model.badge.noKey')}</span>
                      )}
                      {/*
                        没有价格 → 钱永远算不出来。用一个显眼的标签说出来，
                        而不是等用户发现面板上永远是 $0.00
                      */}
                      {prices.every((price) => price.profileId !== profile.id) && (
                        <span className="rounded border border-warn/40 px-1 text-[9.5px] text-warn">
                          {t('model.unpriced')}
                        </span>
                      )}
                    </div>
                    <div className="truncate font-mono text-[9.5px] text-faint">
                      {profile.modelId} · {profile.baseUrl ?? t('model.defaultEndpoint')}
                    </div>
                    {prices
                      .filter((price) => price.profileId === profile.id)
                      .map((price) => (
                        <div
                          key={price.id}
                          className="mt-0.5 flex items-center gap-1 text-[9.5px] text-faint"
                        >
                          <span className="font-mono">{price.modelId}</span>
                          <span>
                            ${price.inputPerMTok} / ${price.outputPerMTok} 每百万 token
                          </span>
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void removePrice(price)}
                            className="text-faint hover:text-bad disabled:opacity-40"
                            title={t('model.price.deleteTitle')}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => {
                        const existing = prices.find(
                          (price) =>
                            price.profileId === profile.id && price.modelId === profile.modelId,
                        )
                        setPriceForm({
                          profileId: profile.id,
                          ...(existing === undefined ? {} : { priceId: existing.id }),
                          modelId: profile.modelId,
                          input: existing === undefined ? '0' : String(existing.inputPerMTok),
                          output: existing === undefined ? '0' : String(existing.outputPerMTok),
                        })
                        setNotice(null)
                      }}
                      className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:text-ink disabled:opacity-40"
                    >
                      {t('model.price.title')}
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void test(profile)}
                      className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:text-ink disabled:opacity-40"
                    >
                      {busy === `test:${profile.id}` ? t('model.test.testing') : t('model.test.action')}
                    </button>
                    {activeId !== profile.id && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void activate(profile)}
                        className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:text-ink disabled:opacity-40"
                      >
                        {t('model.use')}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => {
                        setForm({
                          id: profile.id,
                          label: profile.label,
                          baseUrl: profile.baseUrl ?? '',
                          modelId: profile.modelId,
                          apiKey: '',
                        })
                        setNotice(null)
                      }}
                      className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:text-ink disabled:opacity-40"
                    >
                      {t('model.edit')}
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void remove(profile)}
                      className="rounded border border-line px-1.5 py-0.5 text-[10px] text-faint hover:text-bad disabled:opacity-40"
                    >
                      {t('model.remove')}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {priceForm !== null && (
            <div className="mb-2 rounded-md border border-line bg-panel-2 p-2">
              <div className="mb-1 text-[10px] text-faint">
                价格（美元 / 百万 token）·
                <span className="font-mono text-ink"> {priceForm.modelId}</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-0.5 text-[10px] text-faint">
                  {t('model.price.input')}
                  <input
                    value={priceForm.input}
                    onChange={(event) => setPriceForm({ ...priceForm, input: event.target.value })}
                    className="rounded border border-line bg-panel px-1.5 py-1 font-mono text-[11px] text-ink"
                    inputMode="decimal"
                  />
                </label>
                <label className="flex flex-col gap-0.5 text-[10px] text-faint">
                  {t('model.price.output')}
                  <input
                    value={priceForm.output}
                    onChange={(event) => setPriceForm({ ...priceForm, output: event.target.value })}
                    className="rounded border border-line bg-panel px-1.5 py-1 font-mono text-[11px] text-ink"
                    inputMode="decimal"
                  />
                </label>
              </div>
              <div className="mt-2 flex items-center gap-1">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void savePrice()}
                  className="rounded-md border border-brand/50 bg-brand/10 px-2 py-1 text-[11px] text-brand disabled:opacity-40"
                >
                  {busy === 'price' ? t('model.price.saving') : t('model.price.save')}
                </button>
                <button
                  type="button"
                  onClick={() => setPriceForm(null)}
                  className="rounded-md border border-line px-2 py-1 text-[11px] text-faint hover:text-ink"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}

          {form === null ? (
            <button
              type="button"
              onClick={() => {
                setForm({ ...EMPTY_FORM })
                setNotice(null)
              }}
              className="rounded-md border border-line bg-panel-2 px-2 py-1 text-[11px] text-muted hover:text-ink"
            >
              {t('model.addProvider')}
            </button>
          ) : (
            <div className="rounded-md border border-line bg-panel-2 p-2">
              {form.id === undefined && (
                <div className="mb-2 flex flex-wrap gap-1">
                  {PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() =>
                        setForm((current) =>
                          current === null
                            ? current
                            : {
                                ...current,
                                label: preset.label,
                                baseUrl: preset.baseUrl,
                                modelId: preset.modelId,
                              },
                        )
                      }
                      className="rounded border border-line px-1.5 py-0.5 text-[10px] text-faint hover:text-ink"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-0.5 text-[10px] text-faint">
                  {t('model.field.name')}
                  <input
                    value={form.label}
                    onChange={(event) => setForm({ ...form, label: event.target.value })}
                    className="rounded border border-line bg-panel px-1.5 py-1 text-[11px] text-ink"
                    placeholder={t('model.field.namePlaceholder')}
                  />
                </label>
                <label className="flex flex-col gap-0.5 text-[10px] text-faint">
                  {t('model.field.modelId')}
                  <input
                    value={form.modelId}
                    onChange={(event) => setForm({ ...form, modelId: event.target.value })}
                    className="rounded border border-line bg-panel px-1.5 py-1 text-[11px] text-ink"
                    placeholder="deepseek-chat"
                  />
                </label>
              </div>

              <label className="mt-2 flex flex-col gap-0.5 text-[10px] text-faint">
                端点（OpenAI 兼容，通常以 /v1 结尾）
                <input
                  value={form.baseUrl}
                  onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                  className="rounded border border-line bg-panel px-1.5 py-1 font-mono text-[11px] text-ink"
                />
              </label>

              <label className="mt-2 flex flex-col gap-0.5 text-[10px] text-faint">
                API Key{form.id === undefined ? '' : t('model.field.apiKeyKeep')}
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                  className="rounded border border-line bg-panel px-1.5 py-1 font-mono text-[11px] text-ink"
                  placeholder="sk-…"
                  autoComplete="off"
                />
              </label>

              <div className="mt-2 flex items-center gap-1">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void save()}
                  className="rounded-md border border-brand/50 bg-brand/10 px-2 py-1 text-[11px] text-brand disabled:opacity-40"
                >
                  {busy === 'save' ? t('model.price.saving') : t('model.saveEnabling')}
                </button>
                <button
                  type="button"
                  onClick={() => setForm(null)}
                  className="rounded-md border border-line px-2 py-1 text-[11px] text-faint hover:text-ink"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}

          <div className="mt-2 border-t border-line pt-2 text-[10px] text-faint">
            {t('model.note.encrypted')}
            {t('model.note.price.before')}
    <span className="text-warn">{t('model.note.price.emphasis')}</span>
            ，「按美元设额度」也就不起作用。
          </div>
        </div>
      )}
    </div>
  )
}
