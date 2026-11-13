/**
 * 插件面板（已装 / 商店 / 更新）的文案。
 */
export const pluginsEn = {
  'plugin.title': 'Components',
  'plugin.tip': 'What this app has installed, and what else is available',
  'plugin.tab.installed': 'Installed {count}',
  'plugin.tab.store': 'Store',

  'plugin.source.bundled': 'bundled',
  'plugin.source.hub': 'Hub',
  'plugin.source.local': 'local',

  'plugin.empty.installed':
    'No components yet. Switch to the Store tab, or just tell the agent (e.g. "add an AI assistant").',
  'plugin.enabled': 'enabled',
  'plugin.disabled': 'off',
  'plugin.remove.title': 'Remove from this app (the package stays on this machine and can be added back)',
  'plugin.remove': 'Remove',
  'plugin.loadFailed': 'Failed to load (see below)',

  'plugin.notice.installedFromHub': 'Downloaded from the Hub and installed into this app',
  'plugin.notice.installed': 'Installed into this app',
  'plugin.notice.removed': 'Removed (the package stays on this machine, so it can be added back)',
  'plugin.notice.notInstalled': 'It was never installed',
  'plugin.notice.updated': 'Updated to v{version}; {count} apps reloaded',
  'plugin.notice.updatedNoUser':
    'v{version} is installed, but no app accepts this version (its version range rejects it) — update the assembly manifest',

  'plugin.hub.bundled': 'bundled with the app',
  'plugin.hub.env': 'env var',
  'plugin.checkUpdates.checking': 'Checking…',
  'plugin.checkUpdates.action': 'Check for updates',
  'plugin.updates.unreachable': 'Cannot reach the Hub (installed components keep working): {reason}',
  'plugin.updates.unknown': 'unknown reason',
  'plugin.updates.noneInstalled': 'Nothing from the Hub is installed on this machine yet (bundled components ship with the app).',
  'plugin.updates.allCurrent': 'All {count} Hub components are up to date.',
  'plugin.updates.updating': 'Updating…',
  'plugin.updates.update': 'Update',

  'plugin.store.hubPending': 'The official Hub is being set up — only bundled components are available for now.',
  'plugin.store.refreshing': 'Loading…',
  'plugin.store.refresh': 'Refresh',
  'plugin.store.unreachable': 'Cannot reach the Hub: {reason}. What is already on this machine can still be installed.',
  'plugin.store.noBundled': 'No bundled components to install.',
  'plugin.store.readingHub': 'Reading the Hub catalog…',
  'plugin.store.allInstalled': 'This app already has every component it can take.',

  'plugin.paid': 'paid',
  'plugin.paid.tip': 'Paid components have no purchase flow yet',
  'plugin.installing.downloading': 'Downloading…',
  'plugin.installing.installing': 'Installing…',
  'plugin.install.download': 'Download and install',
  'plugin.install.add': 'Add to this app',

  'plugin.mounts': 'Mounted: {slots}',
  'plugin.problems.count': '{count} could not load',
  'plugin.problems.hint': '({hint})',
  'plugin.hub.label': 'Official Hub: ',
  'plugin.hub.key': '· key {fp}',
  'plugin.update.blocked':
    "Won't take effect: the app(s) {apps} pin a version range that excludes v{version} — widen it in the assembly file",
  'plugin.store.fromHub': '· {count} from Hub',
  'plugin.store.hubBroken': 'Hub is misconfigured: {note}',
} as const

export type PluginsKey = keyof typeof pluginsEn

export const pluginsZh: Record<PluginsKey, string> = {
  'plugin.title': '插件',
  'plugin.tip': '这个应用装了哪些组件 / 还能装什么',
  'plugin.tab.installed': '已装 {count}',
  'plugin.tab.store': '商店',

  'plugin.source.bundled': '内置',
  'plugin.source.hub': 'Hub',
  'plugin.source.local': '本地',

  'plugin.empty.installed': '还没装组件。切到「商店」装一个，或者跟 Agent 说一句（比如「加上 AI 小助手」）。',
  'plugin.enabled': '启用',
  'plugin.disabled': '已关闭',
  'plugin.remove.title': '从这个应用移除（包还在本机，可以再装回来）',
  'plugin.remove': '移除',
  'plugin.loadFailed': '没加载起来（原因见下）',

  'plugin.notice.installedFromHub': '已从 Hub 下载并装到这个应用',
  'plugin.notice.installed': '已装到这个应用',
  'plugin.notice.removed': '已移除（包还在本机，可以再装回来）',
  'plugin.notice.notInstalled': '本来就没装',
  'plugin.notice.updated': '已更新到 v{version}，{count} 个应用已重新加载',
  'plugin.notice.updatedNoUser': '已装好 v{version}。没有应用在用这个版本（版本区间不接受它），需要改装配声明',

  'plugin.hub.bundled': '随包内置',
  'plugin.hub.env': '环境变量',
  'plugin.checkUpdates.checking': '检查中…',
  'plugin.checkUpdates.action': '检查更新',
  'plugin.updates.unreachable': '连不上 Hub（不影响已装的组件）：{reason}',
  'plugin.updates.unknown': '未知原因',
  'plugin.updates.noneInstalled': '本机还没有从 Hub 装的组件（内置组件跟软件版本走）。',
  'plugin.updates.allCurrent': '已装的 {count} 个 Hub 组件都是最新的。',
  'plugin.updates.updating': '更新中…',
  'plugin.updates.update': '更新',

  'plugin.store.hubPending': '官方 Hub 筹备中：现在只有随包发布的内置组件。',
  'plugin.store.refreshing': '读取中…',
  'plugin.store.refresh': '刷新',
  'plugin.store.unreachable': '连不上 Hub：{reason}。本机已有的仍然可以装。',
  'plugin.store.noBundled': '没有可装的内置组件。',
  'plugin.store.readingHub': '正在读取 Hub 目录…',
  'plugin.store.allInstalled': '这个应用已经装了所有能装的组件。',

  'plugin.paid': '付费',
  'plugin.paid.tip': '付费组件还没有购买流程',
  'plugin.installing.downloading': '下载中…',
  'plugin.installing.installing': '安装中…',
  'plugin.install.download': '下载并安装',
  'plugin.install.add': '装到此应用',

  'plugin.mounts': '挂载：{slots}',
  'plugin.problems.count': '装不上的 {count} 条',
  'plugin.problems.hint': '（{hint}）',
  'plugin.hub.label': '官方 Hub：',
  'plugin.hub.key': '· 密钥 {fp}',
  'plugin.update.blocked':
    '装了也用不上：应用 {apps} 声明的版本区间不接受 v{version}（要改装配声明里的区间）',
  'plugin.store.fromHub': '· {count} 个来自 Hub',
  'plugin.store.hubBroken': 'Hub 配置有问题：{note}',
}
