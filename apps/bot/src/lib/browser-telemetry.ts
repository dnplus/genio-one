import { createBrowserObserver } from "@genioone/telemetry/browser-observability"
import { loadGenioToken } from "./genio-one"

export const browserObserver = createBrowserObserver({ service: "genio-one-bot-web", token: loadGenioToken, endpoint: () => "/api/browser-telemetry" })
