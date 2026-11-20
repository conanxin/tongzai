import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

type SqliteResult<T> = {
  success: true;
  results: T[];
  meta: { changes: number; last_row_id: number; duration: number };
};

function binding(value: unknown): SQLInputValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return value as SQLInputValue;
  throw new TypeError('Unsupported SQLite parameter type');
}

/** The D1 surface used by lib/server/service.ts, backed by real SQLite transactions. */
export class SqliteD1 {
  readonly sqlite: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.sqlite = new DatabaseSync(filename);
    this.sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }

  prepare(sql: string): SqlitePrepared {
    return new SqlitePrepared(this, sql, []);
  }

  async batch<T = Record<string, unknown>>(statements: SqlitePrepared[]): Promise<SqliteResult<T>[]> {
    // No await occurs between BEGIN and COMMIT: another HTTP handler cannot enter this transaction.
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => {
        if (statement.database !== this) throw new Error('A batch must use statements from the same database');
        return statement.execute<T>();
      });
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  migrate(directory: string): void {
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS _tongzai_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)');
    const migrations = readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name)).sort();
    if (migrations.length === 0) throw new Error('No database migrations were packaged');
    for (const name of migrations) {
      this.sqlite.exec('BEGIN IMMEDIATE');
      try {
        const applied = this.sqlite.prepare('SELECT name FROM _tongzai_migrations WHERE name = ?').get(name);
        if (!applied) {
          this.sqlite.exec(readFileSync(join(directory, name), 'utf8'));
          this.sqlite.prepare('INSERT INTO _tongzai_migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now());
        }
        this.sqlite.exec('COMMIT');
      } catch (error) {
        this.sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  }

  close(): void { this.sqlite.close(); }
}

class SqlitePrepared {
  readonly database: SqliteD1;
  private readonly sql: string;
  private readonly values: SQLInputValue[];

  constructor(database: SqliteD1, sql: string, values: SQLInputValue[]) {
    this.database = database; this.sql = sql; this.values = values;
  }

  bind(...values: unknown[]): SqlitePrepared {
    return new SqlitePrepared(this.database, this.sql, values.map(binding));
  }

  private statement(): StatementSync { return this.database.sqlite.prepare(this.sql); }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.statement().get(...this.values);
    if (!row) return null;
    return (column === undefined ? row : row[column]) as T;
  }

  async all<T = Record<string, unknown>>(): Promise<SqliteResult<T>> {
    const start = performance.now();
    const rows = this.statement().all(...this.values) as T[];
    return { success: true, results: rows, meta: { changes: 0, last_row_id: 0, duration: performance.now() - start } };
  }

  execute<T = Record<string, unknown>>(): SqliteResult<T> {
    const start = performance.now();
    const statement = this.statement();
    // D1 batch can contain queries as well as writes. The room service currently batches writes.
    if (statement.columns().length > 0) {
      const rows = statement.all(...this.values) as T[];
      return { success: true, results: rows, meta: { changes: 0, last_row_id: 0, duration: performance.now() - start } };
    }
    const result = statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid), duration: performance.now() - start } };
  }

  async run<T = Record<string, unknown>>(): Promise<SqliteResult<T>> { return this.execute<T>(); }
}
