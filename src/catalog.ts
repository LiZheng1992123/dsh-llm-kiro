/**
 * Static Kiro CLI model catalog, captured from
 * `kiro-cli chat --list-models --format json` (kiro-cli 2.18.1, 2026-08).
 * Fallback only when the live CLI catalog is unreachable: the served catalog
 * comes from {@link import('./models.ts').KiroModelCatalog}, and unknown
 * model ids are still passed through to the CLI, which rejects or routes
 * them itself.
 * @module dsh-llm-kiro/catalog
 */

/** One Kiro CLI model entry. */
export interface KiroCatalogModel {
  id: string
  name: string
  description?: string
  /** Model's full context window as reported by the CLI. */
  contextWindow?: number
}

/** Default combined context capacity assumed for Kiro-backed models. */
export const DEFAULT_CONTEXT_WINDOW = 200_000
/** Default per-request output cap assumed for Kiro-backed models. */
export const DEFAULT_MAX_TOKENS = 32_000

/** Every model the account exposed at capture time, in CLI list order. */
export const KIRO_MODELS: readonly KiroCatalogModel[] = [
  { id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', description: 'Experimental preview of OpenAI GPT 5.6 Sol', contextWindow: 272_000 },
  { id: 'gpt-5.6-terra', name: 'gpt-5.6-terra', description: 'Experimental preview of OpenAI GPT 5.6 Terra', contextWindow: 272_000 },
  { id: 'gpt-5.6-luna', name: 'gpt-5.6-luna', description: 'Experimental preview of OpenAI GPT 5.6 Luna', contextWindow: 272_000 },
  { id: 'deepseek-3.2', name: 'deepseek-3.2', description: 'Experimental preview of DeepSeek V3.2', contextWindow: 164_000 },
  { id: 'minimax-m2.5', name: 'minimax-m2.5', description: 'MiniMax M2.5 model', contextWindow: 196_000 },
  { id: 'minimax-m2.1', name: 'minimax-m2.1', description: 'Experimental preview of MiniMax M2.1', contextWindow: 196_000 },
  { id: 'glm-5', name: 'glm-5', description: 'GLM-5 model', contextWindow: 200_000 },
  { id: 'qwen3-coder-next', name: 'qwen3-coder-next', description: 'Experimental preview of Qwen3 Coder Next', contextWindow: 256_000 },
]

/**
 * Map a dsh-side model id onto a kiro-cli model id. Ids pass through
 * unchanged; a `kiro-` prefix is stripped so deployments can namespace.
 */
export function resolveKiroModelId(model: string): string {
  const stripped = model.startsWith('kiro-') && !KIRO_MODELS.some(entry => entry.id === model)
    ? model.slice(5)
    : model
  return stripped.length > 0 ? stripped : model
}
