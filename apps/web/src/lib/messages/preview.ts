/**
 * 预览面板的文案。
 */
export const previewEn = {
  'preview.title': 'Preview',
  'preview.iframeTitle': 'App preview',
  'preview.failed': 'Failed to start',
  'preview.error': 'Preview failed to start',
  'preview.openDiff': 'See what changed in this version',
  'preview.reload': 'Reload the page',
  'preview.restart': 'Restart the preview (after changing deps or config)',
  'preview.openTab': 'Open in a new tab',
  'preview.fullscreenOn': 'Full screen',
  'preview.fullscreenOff': 'Exit full screen',
  'preview.empty.pick': 'Pick an app to preview it here',
  'preview.empty.notStarted': 'Preview not started',
  'preview.start': 'Start preview',
  'preview.retry': 'Retry',

  /* 分阶段进度：首装依赖可能要几十秒，得让人知道在做什么 */
  'preview.step.deps': 'deps',
  'preview.step.db': 'db',
  'preview.step.server': 'server',
  'preview.step.preview': 'first paint',
  'preview.wait.deps': 'Installing dependencies on first start — this takes a moment…',
  'preview.wait.db': 'Starting the app database (WASM PostgreSQL locally)…',
  'preview.wait.server': 'Starting the backend service…',
  'preview.wait.firstScreen': 'Waiting for the first screen…',
} as const

export type PreviewKey = keyof typeof previewEn

export const previewZh: Record<PreviewKey, string> = {
  'preview.title': '预览',
  'preview.iframeTitle': '应用预览',
  'preview.failed': '启动失败',
  'preview.error': '预览启动失败',
  'preview.openDiff': '看看这一版改了什么',
  'preview.reload': '刷新页面',
  'preview.restart': '重启预览（改了依赖或配置后用）',
  'preview.openTab': '在新标签页打开',
  'preview.fullscreenOn': '预览全屏',
  'preview.fullscreenOff': '退出全屏',
  'preview.empty.pick': '选择一个应用后在这里预览',
  'preview.empty.notStarted': '预览未启动',
  'preview.start': '启动预览',
  'preview.retry': '重试',

  'preview.step.deps': '依赖',
  'preview.step.db': '数据',
  'preview.step.server': '服务',
  'preview.step.preview': '首屏',
  'preview.wait.deps': '首次启动会安装依赖，请稍等…',
  'preview.wait.db': '正在启动应用数据库（本地是 WASM 版 PostgreSQL）…',
  'preview.wait.server': '正在启动后端服务…',
  'preview.wait.firstScreen': '等待首屏响应…',
}
