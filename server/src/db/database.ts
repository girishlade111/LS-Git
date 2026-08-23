import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { MIGRATIONS } from './migrations.js'

export type Row = Record<string, unknown>

export class Database {
  readonly raw: DatabaseSync

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
      (this.raw.prepare('SELECT version FROM schema_migrations').all() as Array<Row>).map(
        (r) => Number(r.version),
      ),
    )
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue
      const tx = this.raw.begin()
      try {
        this.raw.exec(m.sql)
        this.raw
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(m.version, new Date().toISOString())
        tx.commit()
      } catch (err) {
        tx.rollback()
        throw err
      }
    }
  }

  get(sql: string, ...params: unknown[]): Row | undefined {
    return this.raw.prepare(sql).get(...params) as Row | undefined
  }

  all(sql: string, ...params: unknown[]): Array<Row> {
    return this.raw.prepare(sql).all(...params) as Array<Row>
  }

  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const res = this.raw.prepare(sql).run(...params)
    return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) }
  }

  transaction<T>(fn: () => T): T {
    const tx = this.raw.begin()
    try {
      const out = fn()
      tx.commit()
      return out
    } catch (err) {
      tx.rollback()
      throw err
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
