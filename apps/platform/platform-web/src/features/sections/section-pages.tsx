/**
 * Barrel for the management section pages. Each page now lives with its own
 * feature; this keeps the existing import path working for callers.
 */
export { ResourceCatalogPage as ResourcesPage } from "@/features/resources/resource-catalog-page"
export { AccessPage } from "@/features/access/access-page"
export { ActivityPage } from "@/features/activity/activity-page"
export { RuntimesPage } from "@/features/runtimes/runtimes-page"
export { IdentityPage } from "@/features/identity/identity-page"
export { OrganizationPage } from "@/features/identity/organization-page"
export { SettingsPage } from "@/features/settings/settings-page"
