import { observeOperation } from "../../../../../packages/telemetry/src/operation-observability"
import postgres, { type Options, type Sql, type TransactionSql } from "postgres"

/**
 * Narrow SQL seam shared by capability repositories and the migration runner.
 * The capability layer never receives the postgres.js tagged-template client;
 * this keeps the driver replaceable without introducing an ORM abstraction.
 */
export interface SqlQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[]
  rowCount: number
}

export interface SqlTransaction {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>
}

export interface SqlAdapter {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>
  transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T>
}

type QueryClient = Pick<Sql, "unsafe" | "begin" | "end">
type TransactionClient = Pick<TransactionSql, "unsafe">

function result<Row extends Record<string, unknown>>(rows: readonly Row[]): SqlQueryResult<Row> {
  const count = (rows as readonly Row[] & { count?: number }).count
  return {
    rows: [...rows],
    rowCount: typeof count === "number" ? count : rows.length,
  }
}

class PostgresQueryExecutor {
  constructor(private readonly client: QueryClient | TransactionClient) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    const unsafe = this.client.unsafe as unknown as <Result extends unknown[]>(
      query: string,
      parameters?: readonly unknown[],
    ) => Promise<Result>
    return observeOperation("genio-one-platform-api", "db.query", { statement: text, parameters_availability: "OMITTED_CREDENTIAL_BOUNDARY" }, async () => {
      const rows = await unsafe<Row[]>(text, parameters === undefined ? undefined : [...parameters])
      return result(rows)
    })
  }
}

class PostgresTransaction implements SqlTransaction {
  private readonly executor: PostgresQueryExecutor

  constructor(client: TransactionClient) {
    this.executor = new PostgresQueryExecutor(client)
  }

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    return this.executor.query<Row>(text, parameters)
  }
}

export interface PostgresSqlAdapterOptions {
  url?: string
  options?: Options<Record<string, never>>
  client?: Sql
}

/** A postgres.js-backed implementation of the capability SQL seam. */
export class PostgresSqlAdapter implements SqlAdapter {
  private readonly client: Sql

  constructor(options: PostgresSqlAdapterOptions = {}) {
    if (options.client) {
      this.client = options.client
      return
    }
    const url = options.url ?? process.env.DATABASE_URL
    this.client = url
      ? postgres(url, options.options)
      : postgres(options.options)
  }

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    return new PostgresQueryExecutor(this.client).query<Row>(text, parameters)
  }

  async transaction<T>(work: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
    return observeOperation("genio-one-platform-api", "db.transaction", {}, () => this.client.begin(async (client) => work(new PostgresTransaction(client))) as Promise<T>)
  }

  async end(options?: { timeout?: number }): Promise<void> {
    await this.client.end(options)
  }
}

export function createPostgresSqlAdapter(
  options: PostgresSqlAdapterOptions = {},
): PostgresSqlAdapter {
  return new PostgresSqlAdapter(options)
}
