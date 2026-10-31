import type { SettingsStore } from './stores/settings.js'

/** 产品级设置键（拼写集中在这里，避免各路由各写一份字符串） */
export const SETTING_KEYS = {
  defaultModelTier: 'agent.defaultModelTier',
  activeProviderId: 'agent.activeProviderId',
  telemetryEnabled: 'telemetry.enabled',
  lastOpenedAppId: 'ui.lastOpenedAppId',
  theme: 'ui.theme',
} as const

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS]

export type { SettingsStore }
