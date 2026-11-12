/**
 * 组件工具（M5 第 4 步）：`list_components` + `install_component`。
 *
 * 为什么必须是**工具**而不是让 Agent 手改 `app.components.json`：
 * 装配声明有三个下游（web facet 注入、server facet 激活、`AGENTS.md` 索引），
 * 手改只更新一个。工具把三件事按同一份事实一次做完，而且用的是**加载器自己的判据**
 * （`buildPlan` 试算）—— 装不上的原因与插件页显示的完全一致。
 *
 * 两个取舍：
 * 1. **装完立刻生效**：`onChanged` 让宿主丢掉缓存重新激活。少了它，用户装完看到的是
 *    "什么都没发生"，而重启之后又突然出现 —— 这种"要重启才生效"的行为最伤信任。
 * 2. **装完把结果说全**：装了哪个版本、挂在哪、要哪些权限。模型会把这段话转述给用户，
 *    所以它必须是用户能看懂的话，不是 `{ok:true}`。
 */
import type { Extension, ToolRegistration } from '@earendil-works/pi-durable'
import { defineExtension } from '@earendil-works/pi-durable'
import { Type } from 'typebox'
import {
  installComponentWithHub,
  listAvailable,
  readAssembly,
  uninstallComponent,
  type HubConfig,
  type PluginRoot,
} from '@tenon/component-host'

export const COMPONENTS_EXTENSION = 'tenon.components'
export const INSTALL_COMPONENT_TOOL = 'install_component'
export const LIST_COMPONENTS_TOOL = 'list_components'
export const REMOVE_COMPONENT_TOOL = 'remove_component'

export interface ComponentsToolsOptions {
  readonly appId: string
  readonly repoDir: string
  readonly roots: readonly PluginRoot[]
  readonly tenonVersion: string
  /** 装/卸之后通知宿主重新激活（不给就"重启才生效"） */
  readonly onChanged?: (appId: string) => void | Promise<void>
  /** 给了它，装组件时本机没有就去 Hub 拿（M6 第 3 步） */
  readonly hub?: { readonly config: HubConfig | null; readonly dir: string } | undefined
}

type Text = { output: { type: 'text'; text: string }[]; isError?: boolean }

function ok(text: string): Text {
  return { output: [{ type: 'text', text }] }
}

function fail(text: string): Text {
  return { output: [{ type: 'text', text }], isError: true }
}

interface InstallArgs {
  readonly id?: string
  readonly slot?: string
  readonly version?: string
}

export function createComponentsTools(options: ComponentsToolsOptions): ToolRegistration[] {
  const list: ToolRegistration = {
    name: LIST_COMPONENTS_TOOL,
    description:
      'List the components you can install into this app, and which ones are already installed. ' +
      'Call this before install_component when you are not sure of an id.',
    parameters: Type.Object({}),
    replay: 'safe',
    async execute() {
      const read = await readAssembly(options.repoDir)
      const installed = read.kind === 'ok' ? read.assembly.components.map((item) => item.id) : []
      const available = await listAvailable({ roots: options.roots, installed })
      if (available.length === 0) {
        return ok('No components are available in this build. Do not write a replacement yourself; tell the user there is nothing to install.')
      }
      const lines = available.map((item) => {
        const mark = item.installed ? ' (installed)' : ''
        return `- ${item.id} — ${item.name} v${item.version}${mark}: ${item.description}`
      })
      return ok(`Installable components:\n${lines.join('\n')}`)
    },
  }

  const install: ToolRegistration = {
    name: INSTALL_COMPONENT_TOOL,
    description:
      'Install a built-in component into this app. It writes app.components.json, keeps docs/AGENTS.md ' +
      'in sync, and makes it live immediately (the platform injects its UI and activates its server side). ' +
      'Do NOT hand-write component code or edit app.components.json yourself — use this tool. ' +
      'Installing twice replaces the previous declaration (idempotent).',
    parameters: Type.Object({
      id: Type.String({ description: 'Component id, e.g. tenon.official.ai-assistant' }),
      slot: Type.Optional(
        Type.String({
          description:
            'Where to mount it (app.shell.overlay / app.page.header / ...). Omit for the component default.',
        }),
      ),
      version: Type.Optional(Type.String({ description: 'Version range such as ^1.0.0. Omit for latest.' })),
    }),
    // 幂等：同 id 再装一次是整条替换，不会长出两条声明
    replay: 'safe',
    async execute(rawArgs) {
      const args = rawArgs as InstallArgs
      const id = args.id?.trim()
      if (id === undefined || id === '') return fail('`id` must not be empty (use list_components to see the ids)')

      const mounts =
        args.slot === undefined || args.slot === ''
          ? undefined
          : [{ slot: args.slot, order: 100 }]

      /*
       * 工具**不能抛**。抛出来的异常会被运行时压成一条 `<harness>` 诊断（错的 message
       * 甚至可能是空的），模型看到的就是这四个字母 —— 既不知道发生了什么，也没法自救。
       * 这里兜住，把它变成一句人话回去。
       */
      let run: Awaited<ReturnType<typeof installComponentWithHub>>
      try {
        run = await installComponentWithHub({
          repoDir: options.repoDir,
          roots: options.roots,
          tenonVersion: options.tenonVersion,
          id,
          ...(mounts === undefined ? {} : { mounts }),
          ...(args.version === undefined || args.version === '' ? {} : { version: args.version }),
          // 本机没有就先去 Hub 拿 —— "跟 Agent 说一句就装上了"靠的是这一行
          ...(options.hub === undefined ? {} : { hub: options.hub }),
        })
      } catch (error) {
        return fail(`Installing ${id} failed: ${error instanceof Error ? error.message : String(error)}`)
      }

      /*
       * 下载侧的原因要**先**看：`installComponent` 在"本机没有这个包"时返回的是
       * `missing`（"找不到组件"），而真正的原因可能是"它是付费的，我们没给下载"。
       * 光看 problems 的话，用户会得到一句"找不到 xxx"，然后去查 id 拼写。
       */
      if (run.downloadError !== null) {
        const detail = run.downloadError
        const tail =
          detail.code === 'HUB_PAID_NOT_AVAILABLE'
            ? 'This is a paid component and there is no purchase flow yet, so it cannot be installed. Tell the user; do not write a replacement.'
            : 'Tell the user this reason; do not write a replacement.'
        return fail(
          `Could not install ${id}: ${detail.message}${detail.hint === null ? '' : ` (${detail.hint})`}\n${tail}`,
        )
      }

      if (!run.result.ok) {
        const detail = run.result.problems
          .map((item) => `- ${item.message}${item.hint === null ? '' : ` (${item.hint})`}`)
          .join('\n')
        return fail(`Could not install ${id}:\n${detail}\nDo not write a replacement; tell the user this reason.`)
      }
      const result = run.result

      try {
        await options.onChanged?.(options.appId)
      } catch {
        // 重新激活失败不该让"装"这个动作报错：声明已经落盘，下次预览会带上它
      }

      const component = result.component
      const where =
        component.mounts.length === 0
          ? 'no UI (server-side capability only)'
          : component.mounts
              .map((mount) => (mount.prefix === null ? mount.slot : `${mount.slot} (${mount.prefix})`))
              .join(', ')
      const notes = result.notes.length === 0 ? '' : `\nNotes: ${result.notes.join('; ')}`
      return ok(
        `Installed ${component.name} (${component.id} v${component.version})${run.downloaded ? ', downloaded from the Hub' : ''}; mounted at ${where}. ` +
          `The assembly declaration is in ${result.assemblyFile} and the "Installed components" section of docs/AGENTS.md is in sync. ` +
          `Its UI is injected by the platform — **do not write a floating button or a chat box yourself**.${notes}`,
      )
    },
  }

  const remove: ToolRegistration = {
    name: REMOVE_COMPONENT_TOOL,
    description:
      'Remove a component from this app. It deletes the entry from app.components.json, clears the ' +
      '"Installed components" section of docs/AGENTS.md, and deactivates the component immediately. ' +
      'Idempotent: removing something that is not installed is fine. The component itself ' +
      '(files shipped with Tenon) is never touched.',
    parameters: Type.Object({
      id: Type.String({ description: 'Component id, e.g. tenon.official.ai-assistant' }),
    }),
    replay: 'safe',
    async execute(rawArgs) {
      const id = (rawArgs as { id?: string }).id?.trim()
      if (id === undefined || id === '') return fail('`id` must not be empty (use list_components to see what is installed)')
      const result = await uninstallComponent({
        repoDir: options.repoDir,
        roots: options.roots,
        tenonVersion: options.tenonVersion,
        id,
      })
      try {
        await options.onChanged?.(options.appId)
      } catch {
        // 重新激活失败不该让"卸"这个动作报错：声明已经删了
      }
      if (!result.removed) {
        return ok(`${id} was not installed. ${result.agentsDoc.changed ? 'The "Installed components" section of AGENTS.md is in sync.' : ''}`)
      }
      const left =
        result.remaining.length === 0
          ? 'This app now has no components.'
          : `Still installed: ${result.remaining.map((item) => item.id).join(', ')}.`
      return ok(`Removed ${id}: the declaration is gone, the "Installed components" section of docs/AGENTS.md is in sync, and the component is deactivated. ${left}`)
    },
  }

  return [list, install, remove]
}

export function componentsExtension(options: ComponentsToolsOptions): Extension {
  return defineExtension({
    name: COMPONENTS_EXTENSION,
    tools: createComponentsTools(options),
  })
}
