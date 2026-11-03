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
import type { ProviderProfile } from '@tenon/protocol'
import { rpc } from '../../lib/rpc.js'
import { cn } from '../../lib/cn.js'
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

const EMPTY_FORM: Form = { label: '', baseUrl: 'https://api.openai.com/v1', modelId: '', apiKey: '' }

/** 常见端点做成快捷键：没有它，90% 的人会在 baseUrl 上写错（漏 /v1 或多写 /chat/completions） */
const PRESETS: { label: string; baseUrl: string; modelId: string }[] = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-chat' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-4o-mini' },
  { label: '本地 LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', modelId: 'local-model' },
]

export interface ModelPanelProps {
  /** 顶栏已经知道的当前模型（workspace 的 boot health）—— 不在这里重复算一份 */
  model: ActiveModel | null
  /** 保存/启用/删除之后通知外面刷新，顶栏标签立刻跟上 */
  onChanged(): Promise<void> | void
}

export function ModelPanel({ model, onChanged }: ModelPanelProps) {
  const [open, setOpen] = useState(false)
  const [profiles, setProfiles] = useState<ProviderProfile[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [list, settings] = await Promise.all([rpc('provider.list', {}), rpc('settings.get', {})])
      setProfiles(list.profiles)
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
      setNotice({ tone: 'bad', text: applied.error ?? '保存了，但没能用起来' })
      return
    }
    setNotice({
      tone: 'ok',
      text: applied.changed
        ? `已生效：${applied.model.modelId}（不用重启）`
        : `设置没变：${applied.model.modelId}`,
    })
  }

  async function save(): Promise<void> {
    if (form === null) return
    if (form.label.trim() === '' || form.modelId.trim() === '') {
      setNotice({ tone: 'bad', text: '名称和模型 id 都得填' })
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
        title={configured ? `当前模型：${model.modelId}（点这里换）` : '还没配置模型，点这里填一个 API Key'}
      >
        {configured ? (model.mode === 'faux' ? '假模型 · 仅验证链路' : model.modelId) : '未配置模型'}
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-50 w-[460px] rounded-lg border border-line bg-panel p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12px] text-ink">模型</span>
            <span className="font-mono text-[10px] text-faint">
              {configured ? `${model.mode} · ${model.providerId}` : '未配置'}
            </span>
          </div>

          {notice !== null && (
            <p className={cn('mb-2 text-[11px]', notice.tone === 'ok' ? 'text-ok' : 'text-bad')}>
              {notice.text}
            </p>
          )}

          {profiles.length === 0 && form === null && (
            <p className="mb-2 text-[11px] text-faint">
              还没有提供商。填一个 API Key 就能开始 —— 密钥存在本机的加密库里，不会上传，也不会进日志。
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
                        <span className="rounded border border-ok/40 px-1 text-[9.5px] text-ok">当前</span>
                      )}
                      {!profile.hasApiKey && (
                        <span className="rounded border border-warn/40 px-1 text-[9.5px] text-warn">缺密钥</span>
                      )}
                    </div>
                    <div className="truncate font-mono text-[9.5px] text-faint">
                      {profile.modelId} · {profile.baseUrl ?? '默认端点'}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void test(profile)}
                      className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:text-ink disabled:opacity-40"
                    >
                      {busy === `test:${profile.id}` ? '测试中…' : '测试'}
                    </button>
                    {activeId !== profile.id && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void activate(profile)}
                        className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:text-ink disabled:opacity-40"
                      >
                        用这个
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
                      改
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void remove(profile)}
                      className="rounded border border-line px-1.5 py-0.5 text-[10px] text-faint hover:text-bad disabled:opacity-40"
                    >
                      删
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {form === null ? (
            <button
              type="button"
              onClick={() => {
                setForm({ ...EMPTY_FORM })
                setNotice(null)
              }}
              className="rounded-md border border-line bg-panel-2 px-2 py-1 text-[11px] text-muted hover:text-ink"
            >
              添加提供商
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
                  名称
                  <input
                    value={form.label}
                    onChange={(event) => setForm({ ...form, label: event.target.value })}
                    className="rounded border border-line bg-panel px-1.5 py-1 text-[11px] text-ink"
                    placeholder="我的 DeepSeek"
                  />
                </label>
                <label className="flex flex-col gap-0.5 text-[10px] text-faint">
                  模型 id
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
                API Key{form.id === undefined ? '' : '（留空 = 不改）'}
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
                  {busy === 'save' ? '保存中…' : '保存并启用'}
                </button>
                <button
                  type="button"
                  onClick={() => setForm(null)}
                  className="rounded-md border border-line px-2 py-1 text-[11px] text-faint hover:text-ink"
                >
                  取消
                </button>
              </div>
            </div>
          )}

          <div className="mt-2 border-t border-line pt-2 text-[10px] text-faint">
            密钥存在本机加密库里（不进环境变量、不进日志、不上传）。保存后立刻生效，不需要重启。
          </div>
        </div>
      )}
    </div>
  )
}
