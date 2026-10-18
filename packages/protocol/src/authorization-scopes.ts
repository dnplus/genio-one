export const GENIOONE_SCOPES = {
  read: "genioone:read",
  write: "genioone:write",
  invoke: "genioone:invoke",
} as const

export const MANAGEMENT_SCOPES = {
  identityRead: "management:identity:read",
  identityWrite: "management:identity:write",
  resourcesRead: "management:resources:read",
  resourcesWrite: "management:resources:write",
  policiesRead: "management:policies:read",
  policiesWrite: "management:policies:write",
  policiesPublish: "management:policies:publish",
  accessRead: "management:access:read",
  accessWrite: "management:access:write",
  accessApprove: "management:access:approve",
  credentialsRead: "management:credentials:read",
  credentialsWrite: "management:credentials:write",
  runtimeRead: "management:runtime:read",
  runtimeWrite: "management:runtime:write",
  auditRead: "management:audit:read",
  auditExport: "management:audit:export",
  systemRead: "management:system:read",
  systemWrite: "management:system:write",
} as const

export const RESOURCE_SCOPE_VALUES = Object.values(GENIOONE_SCOPES)
export const MANAGEMENT_SCOPE_VALUES = Object.values(MANAGEMENT_SCOPES)
export const GENIOONE_SCOPE_VALUES = [...RESOURCE_SCOPE_VALUES, ...MANAGEMENT_SCOPE_VALUES]
export type GenioOneScope = typeof GENIOONE_SCOPE_VALUES[number]

export const GENIOONE_SCOPE_CATALOG: ReadonlyArray<{
  scope: GenioOneScope
  kind: "RESOURCE" | "MANAGEMENT"
  name: { en: string; zhTW: string }
  description: { en: string; zhTW: string }
}> = [
  { scope: GENIOONE_SCOPES.read, kind: "RESOURCE", name: { en: "Read your GenioOne data", zhTW: "讀取您的 GenioOne 資料" }, description: { en: "Read your profile, available resources, and authorized resource data.", zhTW: "讀取您的個人資料、可用資源與已授權的資源資料。" } },
  { scope: GENIOONE_SCOPES.write, kind: "RESOURCE", name: { en: "Update your GenioOne data", zhTW: "更新您的 GenioOne 資料" }, description: { en: "Update your settings and authorized resource data, and submit access requests.", zhTW: "更新您的設定與已授權的資源資料，並提出存取申請。" } },
  { scope: GENIOONE_SCOPES.invoke, kind: "RESOURCE", name: { en: "Invoke GenioOne resources", zhTW: "呼叫 GenioOne 資源" }, description: { en: "Invoke authorized models and agents through GenioOne governance.", zhTW: "透過 GenioOne 治理機制呼叫已授權的模型與代理。" } },
  { scope: MANAGEMENT_SCOPES.identityRead, kind: "MANAGEMENT", name: { en: "Read identity administration", zhTW: "讀取身分管理資料" }, description: { en: "Read subjects, organizations, applications, and login methods within your administration rights.", zhTW: "在您的管理權限內讀取主體、組織、應用程式與登入方式。" } },
  { scope: MANAGEMENT_SCOPES.identityWrite, kind: "MANAGEMENT", name: { en: "Manage identities", zhTW: "管理身分" }, description: { en: "Create or update subjects, organizations, applications, and login methods within your administration rights.", zhTW: "在您的管理權限內建立或更新主體、組織、應用程式與登入方式。" } },
  { scope: MANAGEMENT_SCOPES.resourcesRead, kind: "MANAGEMENT", name: { en: "Read resource administration", zhTW: "讀取資源管理資料" }, description: { en: "Read resource definitions, connections, and providers within your administration rights.", zhTW: "在您的管理權限內讀取資源定義、連線與供應者。" } },
  { scope: MANAGEMENT_SCOPES.resourcesWrite, kind: "MANAGEMENT", name: { en: "Manage resources", zhTW: "管理資源" }, description: { en: "Create, update, or remove resource definitions, connections, and providers within your administration rights.", zhTW: "在您的管理權限內建立、更新或移除資源定義、連線與供應者。" } },
  { scope: MANAGEMENT_SCOPES.policiesRead, kind: "MANAGEMENT", name: { en: "Read policies", zhTW: "讀取政策" }, description: { en: "Read and simulate governance policies within your administration rights.", zhTW: "在您的管理權限內讀取與模擬治理政策。" } },
  { scope: MANAGEMENT_SCOPES.policiesWrite, kind: "MANAGEMENT", name: { en: "Edit policies", zhTW: "編輯政策" }, description: { en: "Create and edit governance policy drafts within your administration rights.", zhTW: "在您的管理權限內建立與編輯治理政策草稿。" } },
  { scope: MANAGEMENT_SCOPES.policiesPublish, kind: "MANAGEMENT", name: { en: "Publish policies", zhTW: "發布政策" }, description: { en: "Approve or publish governance policies within your administration rights.", zhTW: "在您的管理權限內核准或發布治理政策。" } },
  { scope: MANAGEMENT_SCOPES.accessRead, kind: "MANAGEMENT", name: { en: "Read access administration", zhTW: "讀取存取管理資料" }, description: { en: "Read entitlements, access groups, requests, and grants within your administration rights.", zhTW: "在您的管理權限內讀取授權、存取群組、申請與許可。" } },
  { scope: MANAGEMENT_SCOPES.accessWrite, kind: "MANAGEMENT", name: { en: "Manage access", zhTW: "管理存取權限" }, description: { en: "Configure access groups or revoke access within your administration rights.", zhTW: "在您的管理權限內設定存取群組或撤銷存取權限。" } },
  { scope: MANAGEMENT_SCOPES.accessApprove, kind: "MANAGEMENT", name: { en: "Approve access", zhTW: "核准存取" }, description: { en: "Approve or reject access requests and issue grants within your administration rights.", zhTW: "在您的管理權限內核准或拒絕存取申請並發行許可。" } },
  { scope: MANAGEMENT_SCOPES.credentialsRead, kind: "MANAGEMENT", name: { en: "Read credential metadata", zhTW: "讀取憑證資訊" }, description: { en: "Read credential metadata within your administration rights.", zhTW: "在您的管理權限內讀取憑證資訊。" } },
  { scope: MANAGEMENT_SCOPES.credentialsWrite, kind: "MANAGEMENT", name: { en: "Manage credentials", zhTW: "管理憑證" }, description: { en: "Issue, rotate, or revoke credentials within your administration rights.", zhTW: "在您的管理權限內發行、輪替或撤銷憑證。" } },
  { scope: MANAGEMENT_SCOPES.runtimeRead, kind: "MANAGEMENT", name: { en: "Read runtime administration", zhTW: "讀取執行環境管理資料" }, description: { en: "Read gateway and endpoint configuration within your administration rights.", zhTW: "在您的管理權限內讀取 Gateway 與 Endpoint 設定。" } },
  { scope: MANAGEMENT_SCOPES.runtimeWrite, kind: "MANAGEMENT", name: { en: "Manage runtimes", zhTW: "管理執行環境" }, description: { en: "Configure gateways and endpoints within your administration rights.", zhTW: "在您的管理權限內設定 Gateway 與 Endpoint。" } },
  { scope: MANAGEMENT_SCOPES.auditRead, kind: "MANAGEMENT", name: { en: "Read audit records", zhTW: "讀取稽核紀錄" }, description: { en: "Read tenant audit records and activity within your administration rights.", zhTW: "在您的管理權限內讀取租戶稽核紀錄與活動。" } },
  { scope: MANAGEMENT_SCOPES.auditExport, kind: "MANAGEMENT", name: { en: "Export audit records", zhTW: "匯出稽核紀錄" }, description: { en: "Export tenant audit records within your administration rights.", zhTW: "在您的管理權限內匯出租戶稽核紀錄。" } },
  { scope: MANAGEMENT_SCOPES.systemRead, kind: "MANAGEMENT", name: { en: "Read platform configuration", zhTW: "讀取平台設定" }, description: { en: "Read platform configuration, integrations, and diagnostics within your administration rights.", zhTW: "在您的管理權限內讀取平台設定、整合與診斷資料。" } },
  { scope: MANAGEMENT_SCOPES.systemWrite, kind: "MANAGEMENT", name: { en: "Manage platform configuration", zhTW: "管理平台設定" }, description: { en: "Update platform configuration and integrations within your administration rights.", zhTW: "在您的管理權限內更新平台設定與整合。" } },
]

export function isGenioOneScope(value: unknown): value is GenioOneScope {
  return typeof value === "string" && (GENIOONE_SCOPE_VALUES as readonly string[]).includes(value)
}

export function hasAnyScope(scopes: readonly string[] | undefined, required: readonly string[]): boolean {
  return scopes !== undefined && required.some(scope => scopes.includes(scope))
}

export const SELF_SERVICE_OAUTH_SCOPES = ["openid", ...RESOURCE_SCOPE_VALUES] as const
export const BOT_OAUTH_SCOPES = [...SELF_SERVICE_OAUTH_SCOPES, MANAGEMENT_SCOPES.policiesRead, MANAGEMENT_SCOPES.policiesWrite, MANAGEMENT_SCOPES.policiesPublish] as const
export const MANAGEMENT_CONSOLE_OAUTH_SCOPES = ["openid", ...GENIOONE_SCOPE_VALUES] as const
