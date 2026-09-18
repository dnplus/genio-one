import type {
  EndpointActivityEvent,
  EndpointActivityIngest,
  EndpointActivityInventory,
} from "./contract"

export interface EndpointActivityStore {
  record(input: {
    tenantId: string
    deviceId: string
    subjectId: string
    event: EndpointActivityIngest
  }): Promise<EndpointActivityEvent>
  inventory(input: {
    tenantId: string
    deviceId?: string
    recentLimit: number
  }): Promise<EndpointActivityInventory>
}
