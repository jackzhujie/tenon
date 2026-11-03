/**
 * 审批流的契约。
 *
 * V1 刻意只有三种状态（`submitted` / `approved` / `rejected`）：审批流做复杂了就是
 * 工作流引擎，那是另一个产品。这里要验的是**组件规范能不能表达状态机**，
 * 以及"非法转移必须被拒"这类规则写得下写不下。
 */
import { Type } from 'typebox'
import { hostNamed, method, remote } from '@earendil-works/chord'

export type Principal = { readonly appId: string }

export const APPROVAL_TYPE = 'tenon.official.approval'

export const Item = Type.Object({
  id: Type.String(),
  title: Type.String(),
  /** `submitted` | `approved` | `rejected` */
  state: Type.String(),
})

export const Approval = remote(APPROVAL_TYPE, {
  version: 1,
  input: Type.Object({ appId: Type.String() }),
  host: hostNamed('server'),
  variants: {
    user: {
      state: {
        phase: Type.String(),
        /** 待审数量（界面徽标上的数字，省得前端自己 filter） */
        pending: Type.Number(),
        items: Type.Array(Item),
      },
      methods: {
        submit: method(Type.Object({ title: Type.String() }), Type.Object({ id: Type.String() })),
        /** `approve: false` = 驳回 */
        decide: method(Type.Object({ id: Type.String(), approve: Type.Boolean() })),
        reset: method(),
      },
    },
  },
})
