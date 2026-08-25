import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { MIGRATIONS } from './migrations.js'

export type Row = Record<string, unknown>
export type SqlParam = string | number | bigint | Buffer | null

export class Database {
  readonly raw: DatabaseSync
  /** Re-entrancy depth for transaction(); nested calls join the outer tx. */
  private txDepth = 0

  constructor(file: string) {
    if (file !== ':memory:') {
      mkdirSync(dirname(file), { recursive: true })
    }
    this.raw = new DatabaseSync(file)
    this.raw.exec('PRAGMA journal_mode = WAL;')
    this.raw.exec('PRAGMA foreign_keys = ON;')
    this.migrate()
  }

  private migrate(): void {
    this.raw.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         applied_at TEXT NOT NULL
       )`,
    )
    const applied = new Set(
      (this.raw.prepare('SELECT version FROM schema_migrations').all() as unknown[]).map(
        (r) => Number((r as Row).version),
      ),
    )
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue
      this.raw.exec('BEGIN')
      try {
        this.raw.exec(m.sql)
        this.raw
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(m.version, new Date().toISOString())
        this.raw.exec('COMMIT')
      } catch (err) {
        this.raw.exec('ROLLBACK')
        throw err
      }
    }
  }

  get(sql: string, ...params: SqlParam[]): Row | undefined {
    return this.raw.prepare(sql).get(...params) as Row | undefined
  }

  all(sql: string, ...params: SqlParam[]): Array<Row> {
    return this.raw.prepare(sql).all(...params) as unknown as Array<Row>
  }

  run(sql: string, ...params: SqlParam[]): { changes: number; lastInsertRowid: number } {
    const res = this.raw.prepare(sql).run(...params)
    return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) }
  }

  transaction<T>(fn: () => T): T {
    // SQLite has no nested BEGIN; a call inside an open transaction simply
    // joins it (commit/rollback stay with the outermost frame).
    if (this.txDepth > 0) return fn()
    this.raw.exec('BEGIN')
    this.txDepth++
    try {
      const out = fn()
      this.raw.exec('COMMIT')
      return out
    } catch (err) {
      this.raw.exec('ROLLBACK')
      throw err
    } finally {
      this.txDepth--
    }
  }

  close(): void {
    this.raw.close()
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function isoPlus(ms: number): string {
  return new Date(Date.now() + ms).toISOString()
}
