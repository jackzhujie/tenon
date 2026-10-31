/** 应用工作区的文件访问。只允许在 `repo/` 内部读，路径穿越一律拒绝。 */
import { createHash } from 'node:crypto'
import { readdir, readFile as readFileRaw, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { FileNode } from '@tenon/protocol'
import { TenonError } from '@tenon/protocol'

const IGNORED = new Set(['.git', 'node_modules', 'dist', '.tenon', 'pgdata', 'exports'])
const MAX_READ_BYTES = 2_000_000

function safeJoin(root: string, relative: string): string {
  const absolute = resolve(root, relative)
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`
  if (absolute !== root && !absolute.startsWith(rootWithSep)) {
    throw new TenonError('VALIDATION_FAILED', `路径越界：${relative}`, { path: relative })
  }
  return absolute
}

export async function filesTree(root: string, depth = 2): Promise<FileNode[]> {
  const nodes: FileNode[] = []

  async function walk(dir: string, prefix: string, level: number): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        nodes.push({ path: relative, name: entry.name, kind: 'dir' })
        if (level < depth) await walk(join(dir, entry.name), relative, level + 1)
      } else if (entry.isFile()) {
        const info = await stat(join(dir, entry.name))
        nodes.push({ path: relative, name: entry.name, kind: 'file', size: info.size })
      }
    }
  }

  await walk(root, '', 1)
  return nodes
}

export interface FileContent {
  path: string
  content: string
  etag: string
}

export async function readWorkspaceFile(root: string, relative: string): Promise<FileContent> {
  const absolute = safeJoin(root, relative)
  const info = await stat(absolute).catch(() => undefined)
  if (info === undefined || !info.isFile()) {
    throw new TenonError('VALIDATION_FAILED', `文件不存在：${relative}`, { path: relative })
  }
  if (info.size > MAX_READ_BYTES) {
    throw new TenonError('VALIDATION_FAILED', `文件过大（${info.size} 字节），M1 不支持在线打开`, {
      path: relative,
    })
  }
  const buffer = await readFileRaw(absolute)
  return {
    path: relative,
    content: buffer.toString('utf8'),
    etag: createHash('sha1').update(buffer).digest('hex').slice(0, 16),
  }
}
