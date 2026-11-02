/**
 * 打包检查的入口：**故意用最小的一份应用**（一个对象、一个方法），
 * 这样"打包后跑不动"只会是 chord/typebox 的问题，不会是我们自己代码的问题。
 */
import { Type } from 'typebox'
import { createHost, hostNamed, method, remote } from '@earendil-works/chord'

const Counter = remote('tenon.spike.counter', {
  version: 1,
  input: Type.Object({}),
  host: hostNamed('bundle'),
  variants: {
    default: {
      state: { n: Type.Number() },
      methods: { inc: method() },
    },
  },
})

const host = createHost({ name: 'bundle', self: { kind: 'host' } })

host.serve(Counter, (_input, _principal, self) => {
  const n = self.state('n', Type.Number(), 0)
  return {
    variant: 'default',
    n,
    inc: async (ctx) => {
      n.change(ctx, (current) => current + 1)
    },
  }
})

await host.root(async (ctx) => {
  const counter = await ctx.get(Counter, {})
  await counter.inc(ctx)
  await counter.inc(ctx)
  console.log('BUNDLE_OK', counter.n.value)
})

await host.close()
