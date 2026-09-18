import type {
  ConnectionModelMapping,
  AddConnectionModelMappingInput,
  CreatePublicModelInput,
  PublicModel,
} from "./contract"

export interface PublicModelCatalog {
  list(input: {
    tenantId: string
    visibility?: "PUBLIC" | "PRIVATE"
    resourceId?: string
    /** Management views may inspect configured models before Resource publication. */
    includeUnpublishedResources?: boolean
  }): Promise<PublicModel[]>
  get(input: { tenantId: string; modelId: string }): Promise<PublicModel>
  listMappings(input: {
    tenantId: string
    resourceId?: string
    publicModelId?: string
    /** Routing candidates must opt into currently usable Connections. */
    readyOnly?: boolean
  }): Promise<ConnectionModelMapping[]>
  create(input: {
    tenantId: string
    resourceId: string
    value: CreatePublicModelInput
  }): Promise<PublicModel>
  addMapping(input: {
    tenantId: string
    resourceId: string
    modelId: string
    value: AddConnectionModelMappingInput
  }): Promise<ConnectionModelMapping>
}
