import {
  createConfiguredManagementApi,
  managementApiListenOptions,
} from "./bootstrap"

const app = await createConfiguredManagementApi()
await app.listen(managementApiListenOptions())
