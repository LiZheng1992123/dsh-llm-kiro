/**
 * CLI executable resolution with kiro-proxy auto-detection.
 *
 * The kiro-cli-proxy wrapper (`kiro-proxy`, installed at `~/.local/bin/kiro-proxy`)
 * injects per-process proxy env vars from `~/.kiro/settings/cli-proxy.json`
 * before exec'ing the real kiro-cli — the CLI equivalent of the IDE's
 * `Http: Proxy` setting. Its zsh hook only fires for interactive shells, so
 * this plugin (which spawns the CLI directly) would bypass the proxy unless
 * it spawns the wrapper instead. When `cliPath` is left at its default, the
 * resolver therefore prefers an installed wrapper; an explicit `cliPath`
 * always wins, so setting the real CLI's absolute path forces a direct
 * connection.
 * @module dsh-llm-kiro/clipath
 */

import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** The bare command used when nothing is configured (triggers auto-detection). */
export const DEFAULT_CLI_PATH = 'kiro-cli'

/** Wrapper executable name from the kiro-cli-proxy project. */
export const KIRO_PROXY_BIN = 'kiro-proxy'

/** Outcome of {@link resolveKiroCliPath}. */
export interface CliResolution {
  /** Executable to spawn: the explicit value, the wrapper, or the bare default. */
  cliPath: string
  /** Where {@link CliResolution.cliPath} came from. */
  source: 'explicit' | 'proxy-wrapper' | 'default'
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Locate an installed `kiro-proxy` wrapper: the fixed install location
 * `~/.local/bin/kiro-proxy` first, then a PATH scan. Returns the absolute
 * wrapper path, or undefined when no executable wrapper exists.
 */
export function detectKiroProxy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = env.HOME ?? homedir()
  const standard = join(home, '.local', 'bin', KIRO_PROXY_BIN)
  if (isExecutableFile(standard)) return standard
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue
    const candidate = join(dir, KIRO_PROXY_BIN)
    if (isExecutableFile(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolve the executable every kiro-cli spawn goes through. A configured
 * value other than the bare default is used verbatim; the bare default
 * prefers an installed `kiro-proxy` wrapper (absolute path, so a PATH
 * without `~/.local/bin` still finds it) and falls back to `kiro-cli`.
 */
export function resolveKiroCliPath(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CliResolution {
  if (configured !== undefined && configured !== DEFAULT_CLI_PATH) {
    return { cliPath: configured, source: 'explicit' }
  }
  const proxy = detectKiroProxy(env)
  if (proxy !== undefined) return { cliPath: proxy, source: 'proxy-wrapper' }
  return { cliPath: DEFAULT_CLI_PATH, source: 'default' }
}
