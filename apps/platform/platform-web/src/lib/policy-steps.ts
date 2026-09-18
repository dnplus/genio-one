export function preservePolicySteps(generated: Array<Record<string, unknown>>, previous: Array<Record<string, unknown>>, requireConfirmation: boolean) {
  const steps = generated.map((step) => {
    const old = previous.find((candidate) => candidate.step_id === step.step_id)
    if (!old || step.kind === "PROCESS") return step
    if (step.kind === "AUTHORIZE") {
      const config = old.config as Record<string, unknown> | undefined
      const obligations = Array.isArray(config?.required_obligations) ? config.required_obligations.filter((value) => value !== "execution.confirmation") : []
      if (requireConfirmation) obligations.push("execution.confirmation")
      return { ...old, depends_on: step.depends_on, config: { ...config, required_obligations: obligations } }
    }
    return { ...old, depends_on: step.depends_on }
  })
  for (let index = previous.length - 1; index >= 0; index--) {
    const observation = previous[index]!
    if (observation.kind !== "OBSERVE") continue
    const next = previous.slice(index + 1).find((candidate) => steps.some((step) => step.step_id === candidate.step_id))
    const position = next ? steps.findIndex((step) => step.step_id === next.step_id) : steps.length
    steps.splice(position, 0, observation)
  }
  return steps
}
