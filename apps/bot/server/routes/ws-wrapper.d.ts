declare module "*ws/wrapper.mjs" {
  const RealWebSocket: typeof import("ws").default
  export default RealWebSocket
}
