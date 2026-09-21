export interface KeyedSerialExecutor {
  run<T>(key: string, work: () => Promise<T>): Promise<T>
}

export function createKeyedSerialExecutor(): KeyedSerialExecutor {
  const tails = new Map<string, Promise<void>>()

  return {
    async run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve()
      const result = previous.then(work)
      const tail = result.then(() => undefined, () => undefined)
      tails.set(key, tail)
      try {
        return await result
      } finally {
        if (tails.get(key) === tail) tails.delete(key)
      }
    },
  }
}
