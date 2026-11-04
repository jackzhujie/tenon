/**
 * 两套路径的唯一算法（开发态 `apps/desktop/dist` / 打包态 `Contents/Resources`）。
 *
 * 这里只验一件事，但它是"错了不报错"的那种：**每一个由壳指给 server 的路径，
 * 都必须在 `base` 之下**。少一个 `join(base, …)` 写成了别的相对位置，表现是
 * "开发能跑、装完白屏"或"插件页空空如也"，而日志里一个字都没有。
 *
 * `hubConfigFile`（M6 第 5 步）尤其如此：壳把它设成 `TENON_HUB_CONFIG_FILE`，
 * 指错时 `resolveHubConfig` 只会说"读不到"，商店静默变成未配置。
 */
import { describe, expect, it } from 'vitest'
import { resolveDesktopPaths } from '../src/paths.js'

const DEV = resolveDesktopPaths({ isPackaged: false, appPath: '/repo/apps/desktop', resourcesPath: '/ignored' })
const PACKAGED = resolveDesktopPaths({
  isPackaged: true,
  appPath: '/Applications/Tenon.app/Contents/Resources/app.asar',
  resourcesPath: '/Applications/Tenon.app/Contents/Resources',
})

describe('resolveDesktopPaths', () => {
  it('开发态的 base 是 apps/desktop/dist，打包态是 Contents/Resources', () => {
    expect(DEV.base).toBe('/repo/apps/desktop/dist')
    expect(PACKAGED.base).toBe('/Applications/Tenon.app/Contents/Resources')
  })

  it('五个交给 server 的路径都在 base 之下（两种形态同构）', () => {
    for (const paths of [DEV, PACKAGED]) {
      for (const value of [paths.serverEntry, paths.webDir, paths.templatesDir, paths.pluginsDir, paths.hubConfigFile]) {
        expect(value.startsWith(paths.base)).toBe(true)
      }
    }
    // server 的入口必须是 <base>/server/server.mjs：`templates` 的相对位置靠它
    expect(DEV.serverEntry).toBe('/repo/apps/desktop/dist/server/server.mjs')
    expect(DEV.hubConfigFile).toBe('/repo/apps/desktop/dist/hub.json')
    expect(PACKAGED.hubConfigFile).toBe('/Applications/Tenon.app/Contents/Resources/hub.json')
  })

  it('两套形态的目录名一致（只有 base 不同）', () => {
    const strip = (value: string, base: string): string => value.slice(base.length)
    expect(strip(DEV.pluginsDir, DEV.base)).toBe(strip(PACKAGED.pluginsDir, PACKAGED.base))
    expect(strip(DEV.templatesDir, DEV.base)).toBe(strip(PACKAGED.templatesDir, PACKAGED.base))
    expect(strip(DEV.hubConfigFile, DEV.base)).toBe(strip(PACKAGED.hubConfigFile, PACKAGED.base))
  })
})
