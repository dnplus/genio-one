export const DEFAULT_CODEX_MODEL = "gpt-5.3-codex-spark"

export function preferredModel(catalog: readonly { id: string }[], saved: string | null, defaultModel: string | null = DEFAULT_CODEX_MODEL): string {
  if (saved && catalog.some((model) => model.id === saved)) return saved
  return catalog.find((model) => model.id === defaultModel)?.id ?? catalog[0]?.id ?? ""
}
