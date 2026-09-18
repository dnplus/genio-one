import type {
  CreateConfigurationRevisionInput,
  ObserveConfigurationProjectionInput,
  RollbackConfigurationRevisionInput,
  TenantConfigurationRevision,
  TransitionConfigurationRevisionInput,
} from "./contract"

export type ConfigurationTransition = "validate" | "preview" | "review" | "publish"

export interface TenantConfigurationStore {
  list(input: { tenantId: string }): Promise<TenantConfigurationRevision[]>
  published(input: { tenantId: string }): Promise<TenantConfigurationRevision | null>
  create(input: {
    tenantId: string
    createdBySubjectId: string
    value: CreateConfigurationRevisionInput
  }): Promise<TenantConfigurationRevision>
  transition(input: {
    tenantId: string
    revision: string
    transition: ConfigurationTransition
    value: TransitionConfigurationRevisionInput
  }): Promise<TenantConfigurationRevision>
  retry(input: { tenantId: string; revision: string }): Promise<TenantConfigurationRevision>
  observe(input: {
    tenantId: string
    revision: string
    value: ObserveConfigurationProjectionInput
  }): Promise<TenantConfigurationRevision>
  /**
   * Materialize the published revision into the live Self-service read model.
   * Durable stores implement this seam; test stores may leave convergence to
   * an explicit projection observation.
   */
  project?(input: {
    tenantId: string
    revision: string
  }): Promise<TenantConfigurationRevision>
  rollback(input: {
    tenantId: string
    createdBySubjectId: string
    value: RollbackConfigurationRevisionInput
  }): Promise<TenantConfigurationRevision>
}
