import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CLI_PATH, detectKiroProxy, resolveKiroCliPath } from '../src/clipath.ts'

const made: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-llm-kiro-clipath-'))
  made.push(dir)
  return dir
}

function installWrapper(dir: string, executable = true): string {
  mkdirSync(dir, { recursive: true })
  const bin = join(dir, 'kiro-proxy')
  writeFileSync(bin, '#!/usr/bin/env bash\nexit 0\n')
  chmodSync(bin, executable ? 0o755 : 0o644)
  return bin
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true })
})

describe('resolveKiroCliPath', () => {
  it('uses an explicitly configured path verbatim', () => {
    const home = tempDir()
    installWrapper(join(home, '.local', 'bin'))
    const res = resolveKiroCliPath('/opt/custom/kiro-cli', { HOME: home, PATH: '' })
    expect(res).toEqual({ cliPath: '/opt/custom/kiro-cli', source: 'explicit' })
  })

  it('auto-detects the wrapper at ~/.local/bin for the default cliPath', () => {
    const home = tempDir()
    const wrapper = installWrapper(join(home, '.local', 'bin'))
    const res = resolveKiroCliPath(DEFAULT_CLI_PATH, { HOME: home, PATH: '' })
    expect(res).toEqual({ cliPath: wrapper, source: 'proxy-wrapper' })
  })

  it('treats an omitted cliPath like the default', () => {
    const home = tempDir()
    const wrapper = installWrapper(join(home, '.local', 'bin'))
    expect(resolveKiroCliPath(undefined, { HOME: home, PATH: '' }).cliPath).toBe(wrapper)
  })

  it('falls back to a PATH scan when the standard location is empty', () => {
    const home = tempDir()
    const pathDir = tempDir()
    const wrapper = installWrapper(pathDir)
    const res = resolveKiroCliPath(DEFAULT_CLI_PATH, { HOME: home, PATH: pathDir })
    expect(res).toEqual({ cliPath: wrapper, source: 'proxy-wrapper' })
  })

  it('falls back to the bare default when no wrapper exists', () => {
    const home = tempDir()
    const res = resolveKiroCliPath(DEFAULT_CLI_PATH, { HOME: home, PATH: join(home, 'nope') })
    expect(res).toEqual({ cliPath: DEFAULT_CLI_PATH, source: 'default' })
  })

  it('ignores a non-executable wrapper', () => {
    const home = tempDir()
    installWrapper(join(home, '.local', 'bin'), false)
    const res = resolveKiroCliPath(DEFAULT_CLI_PATH, { HOME: home, PATH: '' })
    expect(res).toEqual({ cliPath: DEFAULT_CLI_PATH, source: 'default' })
  })

  it('prefers the standard location over PATH entries', () => {
    const home = tempDir()
    const standard = installWrapper(join(home, '.local', 'bin'))
    const pathDir = tempDir()
    installWrapper(pathDir)
    expect(detectKiroProxy({ HOME: home, PATH: pathDir })).toBe(standard)
  })

  it('skips empty PATH segments and directories named kiro-proxy', () => {
    const home = tempDir()
    const dirNamedWrapper = join(tempDir(), 'kiro-proxy')
    mkdirSync(dirNamedWrapper, { recursive: true })
    const res = resolveKiroCliPath(DEFAULT_CLI_PATH, {
      HOME: home,
      PATH: ['', dirNamedWrapper.slice(0, dirNamedWrapper.lastIndexOf('/'))].join(delimiter),
    })
    expect(res).toEqual({ cliPath: DEFAULT_CLI_PATH, source: 'default' })
  })
})
