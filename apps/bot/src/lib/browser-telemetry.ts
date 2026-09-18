import { createBrowserObserver } from "../../../../packages/telemetry/src/browser-observability"
import { loadGenioToken } from "./genio-one"

export const browserObserver = createBrowserObserver({ service: "genio-one-bot-web", token: loadGenioToken, endpoint: () => "/api/browser-telemetry" })
