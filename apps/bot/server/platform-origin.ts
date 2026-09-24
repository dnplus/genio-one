export function platformOrigin() {
  return process.env.GENIO_ONE_PLATFORM_ORIGIN?.trim() || "http://127.0.0.1:58082"
}
