/**
 * D1Database adapter backed by better-sqlite3.
 *
 * Mimics the Cloudflare D1 prepared-statement API so that every
 * `db.prepare(sql).bind(...).all()` / `.first()` / `.run()` call
 * in packages/db works without modification.
 */
import Database from "better-sqlite3";
import path from "node:path";

// ── D1-compatible types ──────────────────────────────────────
interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = unknown>(): Promise<D1Result<T>>;
  first<T = unknown>(column?: string): Promise<T | null>;
  run(): Promise<D1Result>;
  raw<T = unknown>(): Promise<T[]>;
}

export interface D1DatabaseCompat {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

// ── Implementation ───────────────────────────────────────────
export function createSqliteDatabase(dbPath?: string): D1DatabaseCompat {
  const resolvedPath =
    dbPath ?? path.resolve(process.cwd(), "data", "ig-harness.sqlite");
  const sqlite = new Database(resolvedPath);

  // Enable WAL for better concurrent read performance
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  // bind のたびに「その値を持つ新しい statement」を返す（Cloudflare D1 本物と同じ挙動）。
  // 以前は 1 つの statement の値を書き換えて同じオブジェクトを返していたため、
  // `stmt.bind(a)` と `stmt.bind(b)` を並べて作ると全部が最後の値になり、batch 用の組み立てが壊れていた。
  type Stmt = D1PreparedStatement & { _runSync: () => void };

  function makeStmt(sql: string, boundValues: unknown[]): Stmt {
    const stmt: Stmt = {
      bind(...values: unknown[]) {
        return makeStmt(sql, values);
      },

      async all<T = unknown>(): Promise<D1Result<T>> {
        const s = sqlite.prepare(sql);
        const rows = (
          boundValues.length > 0 ? s.all(...boundValues) : s.all()
        ) as T[];
        return { results: rows, success: true, meta: {} };
      },

      async first<T = unknown>(column?: string): Promise<T | null> {
        const s = sqlite.prepare(sql);
        const row = (
          boundValues.length > 0 ? s.get(...boundValues) : s.get()
        ) as Record<string, unknown> | undefined;
        if (!row) return null;
        if (column) return (row[column] as T) ?? null;
        return row as T;
      },

      async run(): Promise<D1Result> {
        stmt._runSync();
        return { results: [], success: true, meta: {} };
      },

      async raw<T = unknown>(): Promise<T[]> {
        const s = sqlite.prepare(sql);
        const rows = (
          boundValues.length > 0 ? s.raw().all(...boundValues) : s.raw().all()
        ) as T[];
        return rows;
      },

      _runSync() {
        const s = sqlite.prepare(sql);
        boundValues.length > 0 ? s.run(...boundValues) : s.run();
      },
    };
    return stmt;
  }

  return {
    prepare(sql: string): D1PreparedStatement {
      return makeStmt(sql, []);
    },

    // D1 の batch は 1 トランザクションで全部成功か全部失敗。同じ性質を better-sqlite3 の transaction で再現する
    async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
      const run = sqlite.transaction(() => {
        for (const st of statements) (st as Stmt)._runSync();
      });
      run();
      return statements.map(() => ({ results: [], success: true, meta: {} }));
    },
  };
}
