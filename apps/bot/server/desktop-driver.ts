export const COMPUTER_SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024
export const COMPUTER_TEXT_MAX_LENGTH = 4_000
export const COMPUTER_SCROLL_MAX_AMOUNT = 10
export const COMPUTER_SCREEN_MAX_DIMENSION = 4_096

export interface DesktopDriverBinding {
  runtimeSessionId: string
  tenantId: string
  subjectId: string
  actingClientId: string
}

export type DesktopComputerOperation =
  | { operation: "screenshot" }
  | { operation: "click" | "double_click" | "right_click"; x: number; y: number }
  | { operation: "type"; text: string }
  | { operation: "key"; keys: string[] }
  | { operation: "scroll"; direction: "up" | "down"; amount: number }

export interface DesktopComputerOperationResult {
  revision: number
  screenshot?: Uint8Array
}

export interface DesktopComputerExecution {
  actorBotId: string
  expectedRevision?: number
  assertCurrent?: () => void | Promise<void>
}

export interface DesktopComputerDriver {
  readonly binding: DesktopDriverBinding
  execute(operation: DesktopComputerOperation, execution: DesktopComputerExecution): Promise<DesktopComputerOperationResult>
  close(): Promise<void>
}

export interface E2BDesktopSdk {
  screenshot(format: "bytes"): Promise<Uint8Array>
  leftClick(x: number, y: number): Promise<void>
  doubleClick(x: number, y: number): Promise<void>
  rightClick(x: number, y: number): Promise<void>
  write(text: string, options: { chunkSize: number; delayInMs: number }): Promise<void>
  press(keys: string | string[]): Promise<void>
  scroll(direction: "up" | "down", amount: number): Promise<void>
  getScreenSize(): Promise<{ width: number; height: number }>
}

function isIntegerWithin(value: unknown, minimum: number, maximum: number) {
  return Number.isInteger(value) && typeof value === "number" && value >= minimum && value <= maximum
}

function validScreenSize(value: { width: number; height: number }) {
  return isIntegerWithin(value.width, 1, COMPUTER_SCREEN_MAX_DIMENSION) && isIntegerWithin(value.height, 1, COMPUTER_SCREEN_MAX_DIMENSION)
}

export function validComputerKey(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-z0-9]|enter|space|backspace|tab|escape|up|down|left|right|home|end|pageup|pagedown|delete|f(?:[1-9]|1[0-2])|ctrl|shift|alt|meta)$/.test(value)
}

export class E2BDesktopDriver implements DesktopComputerDriver {
  private tail: Promise<void> = Promise.resolve()
  private revision = 0
  private observationBotId: string | null = null
  private closed = false

  constructor(
    private readonly desktop: E2BDesktopSdk,
    readonly binding: DesktopDriverBinding,
  ) {}

  async execute(operation: DesktopComputerOperation, execution: DesktopComputerExecution): Promise<DesktopComputerOperationResult> {
    const previous = this.tail
    let release: () => void = () => undefined
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      if (this.closed) throw new Error("COMPUTER_DRIVER_CLOSED")
      if (!execution.actorBotId.trim()) throw new Error("COMPUTER_ACTOR_BOT_REQUIRED")
      if (execution.expectedRevision !== undefined && execution.expectedRevision !== this.revision) throw new Error("COMPUTER_OBSERVATION_STALE")
      if (operation.operation !== "screenshot") {
        if (execution.expectedRevision === undefined) throw new Error("COMPUTER_OBSERVATION_REQUIRED")
        if (this.observationBotId !== execution.actorBotId) throw new Error("COMPUTER_OBSERVATION_BOT_MISMATCH")
      }
      await execution.assertCurrent?.()
      let attempted = false
      try {
        const result = await this.executeOperation(operation, () => { attempted = true })
        this.revision += 1
        this.observationBotId = operation.operation === "screenshot" ? execution.actorBotId : null
        return { revision: this.revision, ...result }
      } catch (error) {
        if (attempted) {
          this.revision += 1
          this.observationBotId = null
        }
        throw error
      }
    } finally {
      release()
    }
  }

  async close() {
    this.closed = true
    await this.tail
  }

  private async executeOperation(operation: DesktopComputerOperation, markAttempted: () => void): Promise<Pick<DesktopComputerOperationResult, "screenshot">> {
    if (operation.operation === "screenshot") {
      const screenshot = await this.desktop.screenshot("bytes")
      if (!(screenshot instanceof Uint8Array) || screenshot.byteLength === 0 || screenshot.byteLength > COMPUTER_SCREENSHOT_MAX_BYTES) throw new Error("COMPUTER_SCREENSHOT_SIZE_INVALID")
      return { screenshot }
    }
    if (operation.operation === "type") {
      if (typeof operation.text !== "string" || operation.text.length === 0 || operation.text.length > COMPUTER_TEXT_MAX_LENGTH) throw new Error("COMPUTER_TEXT_INVALID")
      markAttempted()
      await this.desktop.write(operation.text, { chunkSize: 25, delayInMs: 10 })
      return {}
    }
    if (operation.operation === "key") {
      if (!Array.isArray(operation.keys) || operation.keys.length === 0 || operation.keys.length > 3 || operation.keys.some((key) => !validComputerKey(key))) throw new Error("COMPUTER_KEY_INVALID")
      markAttempted()
      await this.desktop.press(operation.keys.length === 1 ? operation.keys[0]! : operation.keys)
      return {}
    }
    if (operation.operation === "scroll") {
      if ((operation.direction !== "up" && operation.direction !== "down") || !isIntegerWithin(operation.amount, 1, COMPUTER_SCROLL_MAX_AMOUNT)) throw new Error("COMPUTER_SCROLL_INVALID")
      markAttempted()
      await this.desktop.scroll(operation.direction, operation.amount)
      return {}
    }
    const size = await this.desktop.getScreenSize()
    if (!validScreenSize(size) || !isIntegerWithin(operation.x, 0, size.width - 1) || !isIntegerWithin(operation.y, 0, size.height - 1)) throw new Error("COMPUTER_COORDINATES_INVALID")
    markAttempted()
    if (operation.operation === "click") await this.desktop.leftClick(operation.x, operation.y)
    else if (operation.operation === "double_click") await this.desktop.doubleClick(operation.x, operation.y)
    else if (operation.operation === "right_click") await this.desktop.rightClick(operation.x, operation.y)
    else throw new Error("COMPUTER_OPERATION_INVALID")
    return {}
  }
}
