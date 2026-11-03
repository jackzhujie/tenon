/**
 * Spike 5 的契约。刻意长得像 M5 真要的东西：一个"文档"对象，两种 principal 看到两种变体。
 *
 * 形状是照 DESIGN §21.2 抄的（收费组件 = `guest` 拿不到方法，而不是前端藏按钮），
 * 但这里是**能跑的最小版**：state 三个字段、方法三个（正常 / 改值 / 故意失败）。
 */
import { Type } from 'typebox'
import { hostNamed, method, remote } from '@earendil-works/chord'

/** 应用自己的 principal（chord 不自造：谁调用、以什么身份，全由宿主给） */
export type Principal = { kind: 'owner' } | { kind: 'guest'; id: string }

export const OWNER: Principal = { kind: 'owner' }
export const GUEST: Principal = { kind: 'guest', id: 'g1' }

/** 一个 object per `(type, input, principal)` —— 所以 owner 与 guest 拿到的其实是两个对象 */
export const Sheet = remote('tenon.spike.sheet', {
  version: 1,
  input: Type.Object({ docId: Type.String() }),
  host: hostNamed('server'),
  variants: {
    // 只读：能看状态，一个方法都没有
    viewer: {
      state: {
        title: Type.String(),
        rows: Type.Number(),
        revision: Type.Number(),
      },
    },
    // 可写：同样的状态 + 三个方法
    editor: {
      state: {
        title: Type.String(),
        rows: Type.Number(),
        revision: Type.Number(),
      },
      methods: {
        append: method(Type.Object({ n: Type.Number() }), Type.Object({ rows: Type.Number() })),
        rename: method(Type.Object({ title: Type.String() })),
        boom: method(),
      },
    },
  },
})

/**
 * 热重载那一条用的独立契约：宿主名必须与 `hostNamed` 一致，
 * `serve` 拒绝"放在别处的类型"（这条约束本身也是要验的东西）。
 */
export const Probe = remote('tenon.spike.probe', {
  version: 1,
  input: Type.Object({ id: Type.String() }),
  host: hostNamed('probe'),
  variants: {
    default: {
      state: {
        hits: Type.Number(),
        // Spike 6 加的两样，长得像 AI 小助手的 state：数组 + 带参数的方法
        notes: Type.Array(Type.Object({ role: Type.String(), text: Type.String() })),
        phase: Type.String(),
      },
      methods: {
        hit: method(),
        stamp: method(undefined, Type.Object({ value: Type.String() })),
        note: method(Type.Object({ text: Type.String() })),
      },
    },
  },
})
