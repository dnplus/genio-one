import type { ResourcePublicationRequestSchema } from "./contract"
import type { Static } from "typebox"

export type ResourcePublicationRequest = Static<typeof ResourcePublicationRequestSchema>
