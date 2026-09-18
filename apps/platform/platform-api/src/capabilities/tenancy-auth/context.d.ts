import type { Principal } from "./contract"
import type { ResourceRegistration } from "../resources/contract"

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the authenticated Management API request hook. */
    principal?: Principal
    /** Authority-resolved Resource reused by nested route authorization and handlers. */
    routeResource?: ResourceRegistration
  }
}
