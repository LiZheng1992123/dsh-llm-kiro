/**
 * Register {@link KiroAdapter} for the `kiro` provider route on `ctx.llm`.
 * The inner sessions ride on the local `kiro-cli` login state through the
 * Agent Client Protocol: the advertised model catalog is fetched live from
 * the CLI, every model is addressable by its CLI id, and warm inner sessions
 * close with the plugin.
 * @module @lizheng1992123/dsh-llm-kiro
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { KiroAdapter, KIRO_PROVIDER } from './adapter.ts'

export { KiroAdapter, KIRO_PROVIDER } from './adapter.ts'
export { KiroSession, KiroSessionManager } from './session.ts'
export { KIRO_MODELS, resolveKiroModelId } from './catalog.ts'
export { KiroModelCatalog } from './models.ts'
export { AcpClient } from './acp.ts'
export { HostMcpServer } from './mcpserver.ts'
export { DEFAULT_CLI_PATH, detectKiroProxy, resolveKiroCliPath } from './clipath.ts'
export type { CliResolution } from './clipath.ts'

export const name = 'llm-kiro'
export const inject = ['llm']

const NS = settingsNamespace('llm-kiro')

/** Plugin config; the adapter works entirely off local kiro-cli auth. */
export interface Config {
  /** Maximum simultaneously warm inner kiro-cli sessions. */
  maxSessions?: number
  /** Seconds a fetched CLI model catalog stays fresh before re-fetching. */
  modelCacheTtlSeconds?: number
  /**
   * kiro-cli executable name or absolute path. The default `kiro-cli`
   * auto-detects an installed kiro-proxy wrapper (`~/.local/bin/kiro-proxy`)
   * so the spawned CLI inherits its process-level proxy; set the real CLI's
   * absolute path to bypass the wrapper.
   */
  cliPath?: string
}

export const Config: z<Config> = z.object({
  maxSessions: z.number().step(1).min(1).max(64).default(8),
  modelCacheTtlSeconds: z.number().step(1).min(10).max(86_400).default(300),
  cliPath: z.string().default('kiro-cli'),
})

export function apply(ctx: Context, config: Config): void {
  const adapter = new KiroAdapter({
    maxSessions: config.maxSessions ?? 8,
    modelCacheTtlMs: (config.modelCacheTtlSeconds ?? 300) * 1000,
    cliPath: config.cliPath ?? 'kiro-cli',
  })
  const resolution = adapter.cliResolution
  if (resolution.source === 'proxy-wrapper') {
    ctx.logger.info(`llm-kiro: detected kiro-proxy at ${resolution.cliPath}; spawned kiro-cli processes will use its proxy settings`)
  }
  ctx.llm.registerAdapter([KIRO_PROVIDER], adapter)
  // Declare the route in the configurable-provider directory so selection
  // surfaces (the composer model seat, the Models settings page) render the
  // Kiro group with its display name instead of an anonymous route.
  ctx.llm.registerConfigurableProviders([
    { provider: KIRO_PROVIDER, displayName: 'Kiro CLI', settingsNs: NS, settingsPath: [] },
  ])
  installSettingsSection(ctx, NS, Config, config, { setSource: () => {}, onChange: () => {} })
  // registerAdapter's disposer only withdraws the route; the warm kiro-cli
  // subprocesses are owned by the adapter and must close with the plugin.
  ctx.effect(() => () => adapter.close(), 'llm-kiro.sessions')
}
