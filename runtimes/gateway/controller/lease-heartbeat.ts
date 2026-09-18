export interface LeaseHeartbeatOptions {
  heartbeat(signal: AbortSignal): Promise<void>
  onError(error: unknown): void
  intervalMs?: number
  /** The caller may have just renewed synchronously during startup. */
  startImmediately?: boolean
  signal?: AbortSignal
  schedule?(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  cancel?(timer: ReturnType<typeof setTimeout>): void
}

export interface LeaseHeartbeat {
  stop(): Promise<void>
}

/**
 * Renews the HTTP runtime lease without coupling it to release application.
 * A recursive timeout is deliberate: an unresponsive control plane request
 * cannot overlap its successor and race credential refreshes.
 */
export function startLeaseHeartbeat(options: LeaseHeartbeatOptions): LeaseHeartbeat {
  const intervalMs = options.intervalMs ?? 10_000
  const schedule = options.schedule ?? setTimeout
  const cancel = options.cancel ?? clearTimeout
  const controller = new AbortController()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | undefined

  const stopForShutdown = () => controller.abort()
  options.signal?.addEventListener("abort", stopForShutdown, { once: true })
  if (options.signal?.aborted) stopForShutdown()

  const scheduleNext = () => {
    if (stopped || controller.signal.aborted) return
    timer = schedule(() => {
      timer = undefined
      void renew()
    }, intervalMs)
  }

  const renew = async (): Promise<void> => {
    if (stopped || controller.signal.aborted || inFlight) return
    const current = options.heartbeat(controller.signal)
    inFlight = current
    try {
      await current
    } catch (error) {
      if (!controller.signal.aborted) options.onError(error)
    } finally {
      if (inFlight === current) inFlight = undefined
      scheduleNext()
    }
  }

  if (options.startImmediately === false) scheduleNext()
  else void renew()

  return {
    async stop() {
      if (stopped) return
      stopped = true
      controller.abort()
      options.signal?.removeEventListener("abort", stopForShutdown)
      if (timer !== undefined) {
        cancel(timer)
        timer = undefined
      }
      await inFlight?.catch(() => undefined)
    },
  }
}
