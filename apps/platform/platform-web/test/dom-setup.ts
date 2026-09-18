import { GlobalRegistrator } from "@happy-dom/global-registrator"

const nativeRuntimeGlobals = [
  "fetch",
  "Request",
  "Response",
  "Headers",
  "FormData",
  "Blob",
  "File",
  "AbortController",
  "AbortSignal",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
] as const
const nativeRuntimeGlobalDescriptors = new Map(
  nativeRuntimeGlobals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const),
)

/**
 * Installs a DOM for component tests. Bun loads this through the `[test]`
 * preload entry in apps/platform/bunfig.toml, before any test module is
 * imported, so React and Testing Library see a document when they initialise.
 */
GlobalRegistrator.register()

for (const name of nativeRuntimeGlobals) {
  const descriptor = nativeRuntimeGlobalDescriptors.get(name)
  if (descriptor) Object.defineProperty(globalThis, name, descriptor)
}

// Base UI positions overlays with the Floating UI measurement APIs, which
// happy-dom does not implement. Tests assert on behaviour and markup rather
// than geometry, so a zero-sized rect is enough to let positioning run.
if (!Element.prototype.getBoundingClientRect) {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) } as DOMRect
  }
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

// Testing Library mounts into document.body; without an explicit unmount the
// trees accumulate across files. Imported after registration so Testing
// Library initialises against the DOM installed above.
const { afterEach } = await import("bun:test")
const { cleanup } = await import("@testing-library/react")
afterEach(cleanup)
