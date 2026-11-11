/**
 * 壳层与通用文案（顶栏、启动屏、全局错误条、到处都用的那几个词）。
 *
 * 约定：键是扁平的 `区域.东西.细节`；`{name}` 是插值；复数拆 `.one` / `.other`
 * （中文没有复数，两个键写同一句）。中文表若少一条，`tsc` 会报。
 */
export const shellEn = {
  'common.gotIt': 'Got it',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.save': 'Save',
  'common.saving': 'Saving…',
  'common.clear': 'Clear',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.retry': 'Retry',
  'common.loading': 'Loading…',
  'common.optional': 'optional',
  'common.none': 'None',
  'common.unlimited': 'No limit',
  'common.delete': 'Delete',
  'common.rename': 'Rename',
  'common.confirm': 'Confirm',
  'common.back': 'Back',

  'boot.connecting': 'Connecting to the local service…',
  'boot.failed': 'Cannot reach the local service: {error}',

  /* 相对时间用缩写：英文里 "1 min ago" 与 "2 min ago" 同形，省掉一套复数键 */
  'time.justNow': 'just now',
  'time.minutesAgo': '{count} min ago',
  'time.hoursAgo': '{count} h ago',
  'time.daysAgo': '{count} d ago',

  /* ---- 顶栏：事件流状态与按钮 ---- */
  'header.stream.connecting': 'Connecting',
  'header.stream.open': 'Connected',
  'header.stream.reconnecting': 'Reconnecting',
  'header.stream.failed': 'Disconnected',
  'header.stream.stopped': 'Not connected',
  'header.stream.tooltip': 'Event stream: {state}',
  'header.newApp': 'New app',
  'header.releaseHint': 'Freeze this version and push it to the backup repo',

  /* ---- 自动更新横幅 ---- */
  'update.download': 'Download',
  'update.restart': 'Restart to install',
  'update.retry': 'Retry',
  'update.later': 'Later',
  'update.newVersion': 'Tenon {version} is available',
  'locale.switch': 'Switch language',

  /* ---- 网络层错误（lib/rpc.ts，不是服务端返回的） ---- */
  'error.rpc.unreachable': 'Cannot reach the Tenon service ({host}){detail}',
  'error.rpc.notJson': 'The service returned a non-JSON response (HTTP {status})',
  'error.rpc.failed': 'Request failed',
  'error.rpc.failedStatus': 'Request failed (HTTP {status})',
  'error.noAppSelected': 'No app selected',

  /* ---- 预览框选（lib/selection.ts） ---- */
  'selection.region': 'Area selected',
  'selection.elements': '{count} elements selected',
  'selection.elements.one': '{count} element selected',
  'selection.element': 'Element selected',
  'selection.componentLibrary': ' · component library',

  /* ---- 发布按钮上的悬停说明（lib/release-hint.ts） ---- */
  'release.hint.never':
    'Not published yet — the last {count} versions are all unreleased. Click Publish to run a pre-check; if it passes, this version gets frozen.',
  'release.hint.behind': 'Changed {count} versions since the last release. Click Publish to run a pre-check.',
} as const

export const shellZh: Record<keyof typeof shellEn, string> = {
  'common.gotIt': '知道了',
  'common.cancel': '取消',
  'common.close': '关闭',
  'common.save': '保存',
  'common.saving': '保存中…',
  'common.clear': '清空',
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.retry': '重试',
  'common.loading': '加载中…',
  'common.optional': '可选',
  'common.none': '无',
  'common.unlimited': '不设限',
  'common.delete': '删除',
  'common.rename': '改名',
  'common.confirm': '确定',
  'common.back': '返回',

  'boot.connecting': '正在连接本地服务…',
  'boot.failed': '连不上本地服务：{error}',

  'time.justNow': '刚刚',
  'time.minutesAgo': '{count} 分钟前',
  'time.hoursAgo': '{count} 小时前',
  'time.daysAgo': '{count} 天前',

  'header.stream.connecting': '连接中',
  'header.stream.open': '已连接',
  'header.stream.reconnecting': '重连中',
  'header.stream.failed': '已断开',
  'header.stream.stopped': '未连接',
  'header.stream.tooltip': '事件流：{state}',
  'header.newApp': '新建应用',
  'header.releaseHint': '把这个版本冻结下来并推到备份库',

  'update.download': '下载',
  'update.restart': '重启安装',
  'update.retry': '重试',
  'update.later': '以后再说',
  'update.newVersion': '有新版本 {version}',
  'locale.switch': '切换语言',

  'error.rpc.unreachable': '连不上 Tenon 服务（{host}）{detail}',
  'error.rpc.notJson': '服务返回了非 JSON 响应（HTTP {status}）',
  'error.rpc.failed': '请求失败',
  'error.rpc.failedStatus': '请求失败（HTTP {status}）',
  'error.noAppSelected': '还没有选中应用',

  'selection.region': '已框选区域',
  'selection.elements': '已框选 {count} 个元素',
  'selection.elements.one': '已框选 {count} 个元素',
  'selection.element': '已选中元素',
  'selection.componentLibrary': ' · 组件库',

  'release.hint.never': '还没发布过（最近 {count} 个版本都没发）。点「发布」跑一次预检，通过了就把这一版冻结下来。',
  'release.hint.behind': '上次发布之后又改了 {count} 个版本。点「发布」跑一次预检。',
}
