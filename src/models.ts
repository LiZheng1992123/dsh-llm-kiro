/**
 * Live model catalog retrieval from the local Kiro CLI:
 * `kiro-cli chat --list-models --format json`. The response stays fresh for
 * a TTL, concurrent callers share one in-flight fetch, and the static
 * catalog is the fallback while the CLI is unreachable.
 * @module dsh-llm-kiro/models
 */

import { execFile } from 'node:child_process'
import type { KiroCatalogModel } from './catalog.ts'
import { KIRO_MODELS } from './catalog.ts'

/** How long a fetched catalog stays fresh by default. */
export const DEFAULT_MODEL_CACHE_TTL_MS = 5 * 60_000
/** Give up on one CLI catalog fetch after this long. */
const FETCH_TIMEOUT_MS = 20_000

/** JSON shape of one `kiro-cli chat --list-models --format json` entry. */
interface KiroCliModelEntry {
  model_id?: string
  model_name?: string
  description?: string
  context_window_tokens?: number
}

interface KiroCliModelList {
  models?: KiroCliModelEntry[]
  default_model?: string
}

/** One fetched catalog snapshot with its freshness stamp. */
interface CatalogSnapshot {
  at: number
  models: readonly KiroCatalogModel[]
}

/** Cached live CLI catalog with a static fallback. */
export class KiroModelCatalog {
  private cached: CatalogSnapshot | undefined
  private inflight: Promise<readonly KiroCatalogModel[]> | undefined

  /**
   * @param ttlMs - how long a fetched catalog stays fresh before a re-fetch.
   * @param cliPath - kiro-cli executable (default `kiro-cli`).
   */
  constructor(
    private readonly ttlMs: number,
    private readonly cliPath: string = 'kiro-cli',
  ) {}

  /** Live entries; the stale snapshot when a refresh fails, else nothing. */
  async liveModels(): Promise<readonly KiroCatalogModel[]> {
    const cached = this.cached
    if (cached !== undefined && Date.now() - cached.at < this.ttlMs) return cached.models
    this.inflight ??= this.fetch().finally(() => { this.inflight = undefined })
    try {
      const models = await this.inflight
      if (models.length > 0) this.cached = { at: Date.now(), models }
      return models
    } catch {
      return this.cached?.models ?? []
    }
  }

  /** dsh catalog entries: the live list, or the static fallback. */
  async models(): Promise<readonly KiroCatalogModel[]> {
    const live = await this.liveModels()
    return live.length > 0 ? live : KIRO_MODELS
  }

  private fetch(): Promise<readonly KiroCatalogModel[]> {
    return new Promise((resolve, reject) => {
      execFile(
        this.cliPath,
        ['chat', '--list-models', '--format', 'json'],
        { timeout: FETCH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          if (error !== null) {
            reject(new Error(`kiro-cli --list-models failed: ${error.message}`))
            return
          }
          try {
            const parsed = JSON.parse(stdout) as KiroCliModelList
            const models = (parsed.models ?? [])
              .filter((entry): entry is KiroCliModelEntry & { model_id: string } =>
                typeof entry.model_id === 'string' && entry.model_id.length > 0)
              .map(entry => ({
                id: entry.model_id,
                name: typeof entry.model_name === 'string' && entry.model_name.length > 0
                  ? entry.model_name
                  : entry.model_id,
                ...typeof entry.description === 'string' && entry.description.length > 0
                  ? { description: entry.description }
                  : {},
                ...typeof entry.context_window_tokens === 'number' && entry.context_window_tokens > 0
                  ? { contextWindow: entry.context_window_tokens }
                  : {},
              }))
            resolve(models)
          } catch (parseError) {
            reject(new Error(`kiro-cli --list-models returned unparseable output: ${String(parseError)}`))
          }
        },
      )
    })
  }
}
