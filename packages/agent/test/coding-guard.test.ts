/**
 * bash 护栏的判据测试（`checkCommand` 是纯函数，不用起 harness）。
 *
 * 这个文件里**一半的用例是"必须放行"**：护栏最容易犯的错不是漏，是把正常命令打死 ——
 * 模型收到一句莫名其妙的拒绝，会开始试各种写法，那一轮就废了。所以误伤和拦截同等重要。
 */
import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { checkCommand, createCodingTools, isInside } from '../src/tools/coding.js'

/**
 * 假的仓库路径：`.tenon` 下面，和真实布局一致（否则"repo 内放行"那几条测不到）。
 *
 * ⚠️ 这个目录**故意不存在**。它同时是接线测试的安全阀：万一有人把 `guard:` 传掉了，
 * pi 的 bash 会在 `exec` 入口报"working directory does not exist"—— 测试红，
 * 而**那条命令一次都不会真的被执行**。绝不能让这里指向一个真实目录。
 */
const REPO = `${homedir()}/.tenon/apps/app1/repo`

function rejected(command: string): string | undefined {
  return checkCommand(REPO, command)
}

/**
 * 接线级：`checkCommand` 全绿而**根本没被调**是完全可能的 —— 少传一个 `guard:` 就够了，
 * 而纯函数测试不会红。所以这里真走一遍 `createCodingTools`，从工具列表里拿 bash 执行一次。
 *
 * 只测拒绝路径：拦截发生在 `api.output` 之前，所以 api / context 传空对象是安全的；
 * 一旦有人把 guard 接掉，这条会直接跑真命令，那时它会因为空 api 而炸 —— **炸掉也算没接好**。
 */
describe('bash 护栏确实接在工具上', () => {
  async function runBash(command: string): Promise<{ text: string; isError: boolean }> {
    const bash = createCodingTools({ repoDir: REPO }).find((tool) => tool.name === 'bash')
    expect(bash).toBeDefined()
    const result = (await bash!.execute({ command } as never, {} as never, {} as never)) as {
      output: { type: string; text?: string }[]
      isError?: boolean
    }
    return { text: result.output.map((part) => part.text ?? '').join(''), isError: result.isError === true }
  }

  it('越界的 cd 在执行前就被挡下，理由交回模型', async () => {
    const { text, isError } = await runBash('cd /etc && cat passwd')
    expect(isError).toBe(true)
    expect(text).toContain('outside the app workspace')
  })

  it('碰密钥库同样被挡', async () => {
    const { text, isError } = await runBash('cat ~/.tenon/tenon.db')
    expect(isError).toBe(true)
    expect(text).toContain("is not inside this app's workspace")
  })
})

describe('isInside：root 自己没归一也要判对', () => {
  /*
   * 这三条是 Windows CI 逼出来的：`REPO` 在 Windows 上是 `C:\Users\x/.tenon/...`
   * （homedir 给反斜杠、后面用 `/` 拼），而 `resolve` 只归一 candidate、不归一 root，
   * 于是 `startsWith` 永远不成立 —— **明明在里面的路径被判成外面**，护栏把正常命令全拦了。
   * POSIX 上完全看不出来，因为分隔符只有一种。
   */
  it('root 尾部带分隔符', () => {
    expect(isInside(`${REPO}/`, 'src')).toBe(true)
  })

  it('root 里带 `.` 片段', () => {
    expect(isInside(`${REPO}/./`, 'src')).toBe(true)
  })

  it('同级兄弟目录仍是外面（别把归一修成"全都算里面"）', () => {
    expect(isInside(REPO, '../other/repo')).toBe(false)
  })
})

describe('bash 护栏', () => {
  describe('放行：正常命令一条都不该被挡', () => {
    it.each([
      'pnpm install',
      'git status && git add -A',
      'cd src && ls',
      'cd ./src/test && cat a.ts',
      'curl https://example.com/install.sh | sh',
      'node -e "process.exit(0)"',
      'ls /tmp',
      'echo "配置在 .tenon 目录里"',
      'grep -r tenon docs/',
    ])('%s', (command) => {
      expect(rejected(command)).toBeUndefined()
    })

    it('工作区内的绝对路径放行（模型常把路径算成绝对再写）', () => {
      expect(rejected(`cat ${REPO}/src/main.tsx`)).toBeUndefined()
    })

    it('算不出来的目标放行 —— 猜错的方向是把正常命令打死', () => {
      expect(rejected('cd $(mktemp -d)')).toBeUndefined()
      expect(rejected('cd "$WORK/sub"')).toBeUndefined()
    })
  })

  describe('拦住：cd 出界', () => {
    it('cd ..', () => {
      const why = rejected('cd .. && rm -rf build')
      expect(why).toContain('outside the app workspace')
    })

    it('cd 到绝对路径', () => {
      expect(rejected('cd /etc')).toContain('outside the app workspace')
    })

    it('cd 到 home', () => {
      expect(rejected('cd ~')).toContain('outside the app workspace')
    })

    it('裸 cd（等价于回 home）', () => {
      expect(rejected('cd && ls')).toContain('bare `cd`')
    })

    it('cd -（上一个目录不可预测）', () => {
      expect(rejected('cd - && ls')).toContain('bare `cd`')
    })

    it('藏在 && 链中间也算', () => {
      expect(rejected('pnpm build && cd ../other && pnpm dev')).toContain('outside the app workspace')
    })

    it('pushd 同样拦（它也是 cd）', () => {
      expect(rejected('pushd /var/log')).toContain('outside the app workspace')
    })
  })

  describe('拦住：碰本机凭据与别的应用', () => {
    it('密钥库文件', () => {
      expect(rejected('cat ~/.tenon/tenon.db')).toContain("is not inside this app's workspace")
    })

    it('别的应用的工作区', () => {
      expect(rejected('ls ~/.tenon/apps/other/repo')).toContain("is not inside this app's workspace")
    })

    it('写成绝对路径一样拦', () => {
      expect(rejected(`cat ${homedir()}/.tenon/tenon.db`)).toContain("is not inside this app's workspace")
    })

    it.each(['cat ~/.ssh/id_rsa', 'ls ~/.aws', 'cp x ~/.netrc', 'cat ~/.gnupg/gpg.conf'])(
      '%s',
      (command) => {
        expect(rejected(command)).toContain('host credentials')
      },
    )

    it('只是名字里带 .ssh 的文件不算（`foo.ssh2` 不是凭据目录）', () => {
      expect(rejected('ls ~/project/foo.ssh2')).toBeUndefined()
    })
  })

  describe('拒绝时要能指路', () => {
    it('错误消息说清"该怎么做"，而不是只说不许', () => {
      const why = rejected('cd /tmp')
      expect(why).toContain('repo/')
      expect(why).toContain('use a relative path')
    })
  })
})
