import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 呈现平面落盘：全轨迹（每次隐藏补全的原始输出、分布、对阵）写入
 * <cwd>/.verifier/traces/，绝不进入上下文。墓碑表封顶最近 10 条。
 */

export interface TraceSink {
  writeTrace(name: string, content: string): Promise<string>
  appendGraveyard(entry: string): Promise<void>
  graveyardTail(max: number): Promise<string[]>
}

const TRACES_DIR = '.verifier/traces'
const GRAVEYARD = '.verifier/graveyard.md'

export function createTraceSink(cwd: string): TraceSink {
  const tracesDir = join(cwd, TRACES_DIR)
  return {
    async writeTrace(name, content) {
      const file = join(tracesDir, `${Date.now()}-${name.replace(/\.md$/, '')}.md`)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, content, 'utf8')
      return `${TRACES_DIR}/${file.split('/').pop()}`
    },
    async appendGraveyard(entry) {
      const file = join(cwd, GRAVEYARD)
      await mkdir(dirname(file), { recursive: true })
      let lines: string[] = []
      try {
        lines = (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim().length > 0)
      } catch {
        // first tombstone
      }
      lines.push(`- [${new Date().toISOString().slice(0, 10)}] ${entry}`)
      await writeFile(file, `${lines.slice(-10).join('\n')}\n`, 'utf8')
    },
    async graveyardTail(max) {
      try {
        const lines = (await readFile(join(cwd, GRAVEYARD), 'utf8')).split('\n').filter((l) => l.trim())
        return lines.slice(-max)
      } catch {
        return []
      }
    },
  }
}

/** Unused import guard: appendFile kept for future streaming traces. */
void appendFile
