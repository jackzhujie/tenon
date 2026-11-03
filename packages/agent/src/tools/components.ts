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
  installComponent,
  listAvailable,
  readAssembly,
  uninstallComponent,
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
        return ok('这个版本没有可用的组件。不要自己写一个替代品；告诉用户"没有可装的组件"。')
      }
      const lines = available.map((item) => {
        const mark = item.installed ? '（已装）' : ''
        return `- ${item.id} — ${item.name} v${item.version}${mark}：${item.description}`
      })
      return ok(`可装组件：\n${lines.join('\n')}`)
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
      if (id === undefined || id === '') return fail('id 不能为空（用 list_components 看有哪些）')

      const mounts =
        args.slot === undefined || args.slot === ''
          ? undefined
          : [{ slot: args.slot, order: 100 }]

      const result = await installComponent({
        repoDir: options.repoDir,
        roots: options.roots,
        tenonVersion: options.tenonVersion,
        id,
        ...(mounts === undefined ? {} : { mounts }),
        ...(args.version === undefined || args.version === '' ? {} : { version: args.version }),
      })

      if (!result.ok) {
        const detail = result.problems
          .map((item) => `- ${item.message}${item.hint === null ? '' : `（${item.hint}）`}`)
          .join('\n')
        return fail(`没装上 ${id}：\n${detail}\n不要自己写一个替代品；把这条原因告诉用户。`)
      }

      try {
        await options.onChanged?.(options.appId)
      } catch {
        // 重新激活失败不该让"装"这个动作报错：声明已经落盘，下次预览会带上它
      }

      const component = result.component
      const where =
        component.mounts.length === 0
          ? '没有界面（只有服务端能力）'
          : component.mounts
              .map((mount) => (mount.prefix === null ? mount.slot : `${mount.slot}（${mount.prefix}）`))
              .join('、')
      const notes = result.notes.length === 0 ? '' : `\n注意：${result.notes.join('；')}`
      return ok(
        `已装 ${component.name}（${component.id} v${component.version}），挂载：${where}。` +
          `装配声明写在 ${result.assemblyFile}，docs/AGENTS.md 的「已装组件」已同步。` +
          `它的 UI 由平台注入，**不要再去写悬浮球/聊天框**。${notes}`,
      )
    },
  }

  const remove: ToolRegistration = {
    name: REMOVE_COMPONENT_TOOL,
    description:
      'Remove a component from this app. It deletes the entry from app.components.json, clears the ' +
      '"已装组件" section of docs/AGENTS.md, and deactivates the component immediately. ' +
      'Idempotent: removing something that is not installed is fine. The component itself ' +
      '(files shipped with Tenon) is never touched.',
    parameters: Type.Object({
      id: Type.String({ description: 'Component id, e.g. tenon.official.ai-assistant' }),
    }),
    replay: 'safe',
    async execute(rawArgs) {
      const id = (rawArgs as { id?: string }).id?.trim()
      if (id === undefined || id === '') return fail('id 不能为空（用 list_components 看装了哪些）')
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
        return ok(`${id} 本来就没装。${result.agentsDoc.changed ? 'AGENTS.md 的「已装组件」已同步。' : ''}`)
      }
      const left = result.remaining.length === 0 ? '现在这个应用没有装任何组件' : `还剩：${result.remaining.map((item) => item.id).join('、')}`
      return ok(`已卸 ${id}：装配声明删了，docs/AGENTS.md 的「已装组件」已同步，组件已停用。${left}。`)
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
