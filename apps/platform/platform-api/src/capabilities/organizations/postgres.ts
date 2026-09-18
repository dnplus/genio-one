import { PlatformApiError } from "../errors"
import type { SqlAdapter, SqlTransaction } from "../../persistence/sql-adapter"
import type { CreateOrganizationCommand, ListOrganizationsInput, OrganizationDirectory } from "./module"
import type { Organization } from "./contract"

type OrganizationRow = Record<string, unknown>

export interface PostgresOrganizationOptions {
  sql: SqlAdapter
  now?: () => number
  idFactory?: (prefix: string) => string
}

function assertTenantId(tenantId: string): void {
  if (!tenantId.trim()) {
    throw new PlatformApiError("TENANT_REQUIRED", 422, "A tenant id is required")
  }
}

function required(value: string, code: string): string {
  const normalized = value.trim()
  if (!normalized) throw new PlatformApiError(code, 422)
  return normalized
}

function rowString(row: OrganizationRow, key: string): string {
  const value = row[key]
  return typeof value === "string" ? value : String(value ?? "")
}

function rowTimestamp(row: OrganizationRow, key: string, fallback: number): number {
  const value = row[key]
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string") {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return Math.floor(numeric)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000)
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return Math.floor(value.getTime() / 1000)
  }
  return fallback
}

function mapOrganization(row: OrganizationRow, now: () => number): Organization {
  return {
    tenant_id: rowString(row, "tenant_id"),
    organization_id: rowString(row, "organization_id"),
    display_name: rowString(row, "display_name"),
    slug: rowString(row, "slug"),
    member_subject_ids: [],
    organization_administrator_subject_ids: [],
    membership_sources: [],
    created_at: rowTimestamp(row, "created_at", now()),
  }
}

function isSqlError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-$/g, "")
}

const ORGANIZATION_COLUMNS = `
  tenant_id,
  organization_id,
  display_name,
  slug,
  created_at`

async function queryOrganization(
  executor: SqlAdapter | SqlTransaction,
  tenantId: string,
  organizationId: string,
  suffix = "",
): Promise<OrganizationRow | null> {
  const result = await executor.query<OrganizationRow>(
    `select ${ORGANIZATION_COLUMNS}
       from genio_one_organizations
      where tenant_id = $1 and organization_id = $2${suffix}`,
    [tenantId, organizationId],
  )
  return result.rows[0] ?? null
}

async function hydrateOrganization(
  executor: SqlAdapter | SqlTransaction,
  organization: Organization,
): Promise<Organization> {
  const [memberships, sources] = await Promise.all([
    executor.query<OrganizationRow>(
      `select subject_id, role
         from genio_one_organization_memberships
        where tenant_id = $1 and organization_id = $2
        order by subject_id asc`,
      [organization.tenant_id, organization.organization_id],
    ),
    executor.query<OrganizationRow>(
      `select kind, reference, status
         from genio_one_organization_membership_sources
        where tenant_id = $1 and organization_id = $2
        order by kind asc, reference asc`,
      [organization.tenant_id, organization.organization_id],
    ),
  ])
  return {
    ...organization,
    member_subject_ids: memberships.rows.map((row) => rowString(row, "subject_id")),
    organization_administrator_subject_ids: memberships.rows
      .filter((row) => rowString(row, "role") === "ORGANIZATION_ADMINISTRATOR")
      .map((row) => rowString(row, "subject_id")),
    membership_sources: sources.rows.map((row) => ({
      kind: rowString(row, "kind") as Organization["membership_sources"][number]["kind"],
      reference: rowString(row, "reference"),
      status: rowString(row, "status") as Organization["membership_sources"][number]["status"],
    })),
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

async function replaceMemberships(
  transaction: SqlTransaction,
  input: {
    tenantId: string
    organizationId: string
    memberSubjectIds: readonly string[]
    administratorSubjectIds: readonly string[]
  },
): Promise<void> {
  const members = unique(input.memberSubjectIds)
  const administrators = new Set(unique(input.administratorSubjectIds))
  if ([...administrators].some((subjectId) => !members.includes(subjectId))) {
    throw new PlatformApiError(
      "ORGANIZATION_ADMINISTRATOR_MEMBERSHIP_REQUIRED",
      422,
      "Organization Administrators must be Organization members",
    )
  }
  await transaction.query(
    `delete from genio_one_organization_memberships
      where tenant_id = $1 and organization_id = $2`,
    [input.tenantId, input.organizationId],
  )
  for (const subjectId of members) {
    await transaction.query(
      `insert into genio_one_organization_memberships
         (tenant_id, organization_id, subject_id, role)
       values ($1, $2, $3, $4)`,
      [
        input.tenantId,
        input.organizationId,
        subjectId,
        administrators.has(subjectId) ? "ORGANIZATION_ADMINISTRATOR" : "USER",
      ],
    )
  }
}

export function createPostgresOrganizationDirectory(
  options: PostgresOrganizationOptions,
): OrganizationDirectory {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const idFactory = options.idFactory ?? ((prefix: string) => `${prefix}-${crypto.randomUUID()}`)

  return {
    async list(input: ListOrganizationsInput) {
      assertTenantId(input.tenantId)
      const result = await options.sql.query<OrganizationRow>(
        `select ${ORGANIZATION_COLUMNS}
           from genio_one_organizations
          where tenant_id = $1
          order by display_name asc, organization_id asc`,
        [input.tenantId],
      )
      if (result.rows.length === 0) return []

      const [membershipsResult, sourcesResult] = await Promise.all([
        options.sql.query<OrganizationRow>(
          `select organization_id, subject_id, role
             from genio_one_organization_memberships
            where tenant_id = $1
            order by organization_id asc, subject_id asc`,
          [input.tenantId],
        ),
        options.sql.query<OrganizationRow>(
          `select organization_id, kind, reference, status
             from genio_one_organization_membership_sources
            where tenant_id = $1
            order by organization_id asc, kind asc, reference asc`,
          [input.tenantId],
        ),
      ])

      const membershipsByOrg = new Map<string, Array<{ subjectId: string; role: string }>>()
      for (const row of membershipsResult.rows) {
        const orgId = rowString(row, "organization_id")
        let list = membershipsByOrg.get(orgId)
        if (!list) {
          list = []
          membershipsByOrg.set(orgId, list)
        }
        list.push({
          subjectId: rowString(row, "subject_id"),
          role: rowString(row, "role"),
        })
      }

      const sourcesByOrg = new Map<string, Organization["membership_sources"]>()
      for (const row of sourcesResult.rows) {
        const orgId = rowString(row, "organization_id")
        let list = sourcesByOrg.get(orgId)
        if (!list) {
          list = []
          sourcesByOrg.set(orgId, list)
        }
        list.push({
          kind: rowString(row, "kind") as Organization["membership_sources"][number]["kind"],
          reference: rowString(row, "reference"),
          status: rowString(row, "status") as Organization["membership_sources"][number]["status"],
        })
      }

      return result.rows.map((row) => {
        const org = mapOrganization(row, now)
        const orgMembers = membershipsByOrg.get(org.organization_id) ?? []
        const orgSources = sourcesByOrg.get(org.organization_id) ?? []
        return {
          ...org,
          member_subject_ids: orgMembers.map((m) => m.subjectId),
          organization_administrator_subject_ids: orgMembers
            .filter((m) => m.role === "ORGANIZATION_ADMINISTRATOR")
            .map((m) => m.subjectId),
          membership_sources: orgSources,
        }
      })
    },

    async create(input: CreateOrganizationCommand) {
      assertTenantId(input.tenantId)
      const displayName = input.display_name.trim()
      const slug = slugify(input.slug ?? displayName)
      if (!displayName) {
        throw new PlatformApiError("INVALID_ORGANIZATION_NAME", 422)
      }
      if (!slug) {
        throw new PlatformApiError("INVALID_ORGANIZATION_SLUG", 422)
      }

      const organizationId = idFactory("org")
      try {
        return await options.sql.transaction(async (transaction) => {
          const result = await transaction.query<OrganizationRow>(
            `insert into genio_one_organizations
               (tenant_id, organization_id, display_name, slug)
             values ($1, $2, $3, $4)
             returning ${ORGANIZATION_COLUMNS}`,
            [input.tenantId, organizationId, displayName, slug],
          )
          const row = result.rows[0]
          if (!row) throw new PlatformApiError("ORGANIZATION_CREATE_FAILED", 500)
          await replaceMemberships(transaction, {
            tenantId: input.tenantId,
            organizationId,
            memberSubjectIds: input.member_subject_ids ?? [],
            administratorSubjectIds: [],
          })
          await transaction.query(
            `insert into genio_one_organization_membership_sources
               (tenant_id, organization_id, kind, reference, status)
             values ($1, $2, 'MANUAL', 'console', 'SYNCED')`,
            [input.tenantId, organizationId],
          )
          return hydrateOrganization(transaction, mapOrganization(row, now))
        })
      } catch (error) {
        if (isSqlError(error, "23505")) {
          throw new PlatformApiError("ORGANIZATION_SLUG_EXISTS", 409)
        }
        if (isSqlError(error, "23503")) {
          throw new PlatformApiError("ORGANIZATION_MEMBER_NOT_FOUND", 422)
        }
        throw error
      }
    },

    async get(input: { tenantId: string; organizationId: string }) {
      assertTenantId(input.tenantId)
      if (!input.organizationId.trim()) {
        throw new PlatformApiError("ORGANIZATION_REQUIRED", 422)
      }
      const row = await queryOrganization(options.sql, input.tenantId, input.organizationId)
      if (!row) throw new PlatformApiError("ORGANIZATION_NOT_FOUND", 404)
      return hydrateOrganization(options.sql, mapOrganization(row, now))
    },

    async update(input) {
      assertTenantId(input.tenantId)
      const displayName = input.value.display_name.trim()
      if (!displayName) throw new PlatformApiError("INVALID_ORGANIZATION_NAME", 422)
      try {
        return await options.sql.transaction(async (transaction) => {
          const result = await transaction.query<OrganizationRow>(
            `update genio_one_organizations
                set display_name = $3,
                    row_revision = row_revision + 1,
                    updated_at = now()
              where tenant_id = $1 and organization_id = $2
              returning ${ORGANIZATION_COLUMNS}`,
            [input.tenantId, input.organizationId, displayName],
          )
          const row = result.rows[0]
          if (!row) throw new PlatformApiError("ORGANIZATION_NOT_FOUND", 404)
          await replaceMemberships(transaction, {
            tenantId: input.tenantId,
            organizationId: input.organizationId,
            memberSubjectIds: input.value.member_subject_ids,
            administratorSubjectIds: input.value.organization_administrator_subject_ids,
          })
          await transaction.query(
            `delete from genio_one_organization_membership_sources
              where tenant_id = $1 and organization_id = $2`,
            [input.tenantId, input.organizationId],
          )
          for (const source of input.value.membership_sources) {
            await transaction.query(
              `insert into genio_one_organization_membership_sources
                 (tenant_id, organization_id, kind, reference, status)
               values ($1, $2, $3, $4, $5)`,
              [
                input.tenantId,
                input.organizationId,
                source.kind,
                required(source.reference, "ORGANIZATION_MEMBERSHIP_SOURCE_REQUIRED"),
                source.status,
              ],
            )
          }
          return hydrateOrganization(transaction, mapOrganization(row, now))
        })
      } catch (error) {
        if (isSqlError(error, "23503")) {
          throw new PlatformApiError("ORGANIZATION_MEMBER_NOT_FOUND", 422)
        }
        throw error
      }
    },

    async accessForSubject(input) {
      assertTenantId(input.tenantId)
      const result = await options.sql.query<OrganizationRow>(
        `select organization_id, role
           from genio_one_organization_memberships
          where tenant_id = $1 and subject_id = $2
          order by organization_id asc`,
        [input.tenantId, required(input.subjectId, "SUBJECT_REQUIRED")],
      )
      return {
        organization_ids: result.rows.map((row) => rowString(row, "organization_id")),
        administrator_organization_ids: result.rows
          .filter((row) => rowString(row, "role") === "ORGANIZATION_ADMINISTRATOR")
          .map((row) => rowString(row, "organization_id")),
      }
    },
  }
}
