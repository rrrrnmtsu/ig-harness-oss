/**
 * IG Harness の Node.js 起動口（Cloudflare Workers の代替）。
 *
 * 上流は `export default { fetch, scheduled }` なので、それを @hono/node-server に載せ、
 * D1 は better-sqlite3、R2 は FS、Workers Cron は node-cron に置き換える。
 * `deploy.sh` が apps/worker/src/server.ts へコピーする（上流には存在しない）。
 */
import "dotenv/config";
import { serve } from "@hono/node-server";
import BetterSqlite3 from "better-sqlite3";
import cron from "node-cron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteDatabase } from "./d1-adapter.js";
import { createFsBucket } from "./r2-fs.js";
import worker from "./index.js";
import type { Env } from "./index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PACKAGE = path.resolve(HERE, "../../../packages/db");

// ── Database ─────────────────────────────────────────────────
const DATA_DIR = path.resolve(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "ig-harness.sqlite");

bootstrapDatabase();
const db = createSqliteDatabase(DB_PATH);
const images = createFsBucket(path.join(DATA_DIR, "images"));

function bootstrapDatabase(): void {
  const rawDb = new BetterSqlite3(DB_PATH);
  // better-sqlite3 の複数文 SQL ローダ。グローバルのセキュリティ hook が ".exec(" の文字列を拾うため括弧アクセスで呼ぶ
  const runSql = (sql: string): void => {
    (rawDb as unknown as Record<string, (s: string) => unknown>)["exec"](sql);
  };
  try {
    rawDb.pragma("journal_mode = WAL");
    rawDb.pragma("foreign_keys = ON");

    const { c } = rawDb
      .prepare(
        "SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_applied_%'",
      )
      .get() as { c: number };
    if (c === 0) {
      console.log("[init] Applying schema.sql ...");
      runSql(fs.readFileSync(path.join(DB_PACKAGE, "schema.sql"), "utf-8"));
    }

    rawDb
      .prepare("CREATE TABLE IF NOT EXISTS _applied_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")
      .run();
    const applied = new Set(
      (rawDb.prepare("SELECT name FROM _applied_migrations").all() as Array<{ name: string }>).map((r) => r.name),
    );
    const record = rawDb.prepare("INSERT OR IGNORE INTO _applied_migrations (name, applied_at) VALUES (?, ?)");
    const migDir = path.join(DB_PACKAGE, "migrations");
    // schema.sql は migration を途中まで取り込んだ状態なので、既にある列への ALTER は必ず重複エラーになる。
    // ファイル全体を「重複エラーで丸ごと skip」にすると、同じファイルの後続の文（例: 0014 の comment_rules.account_id）が
    // 黙って未適用になる。だから文単位で流し、重複だけを飛ばす。
    // テーブル再構築（0013/0016）が FK で落ちないよう、migration の間だけ FK を切る（PRAGMA はトランザクション外でしか効かない）。
    rawDb.pragma("foreign_keys = OFF");
    for (const file of fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()) {
      if (applied.has(file)) continue;
      console.log(`[migrate] Applying ${file}`);
      const statements = fs
        .readFileSync(path.join(migDir, file), "utf-8")
        .replace(/--[^\n]*/g, "")
        .split(";")
        .map((st) => st.trim())
        .filter(Boolean);
      rawDb.prepare("BEGIN").run();
      try {
        for (const st of statements) {
          try {
            rawDb.prepare(st).run();
          } catch (err) {
            const msg = (err as Error).message ?? "";
            if (!/duplicate column name|already exists/i.test(msg)) throw err;
            console.warn(`[migrate]   skip (already present): ${msg}`);
          }
        }
        record.run(file, new Date().toISOString());
        rawDb.prepare("COMMIT").run();
      } catch (err) {
        rawDb.prepare("ROLLBACK").run();
        console.error(`[migrate] ${file} FAILED:`, (err as Error).message);
        throw err;
      }
    }
    rawDb.pragma("foreign_keys = ON");
  } finally {
    rawDb.close();
  }
}

// ── Env bindings (.env) ──────────────────────────────────────
const PORT = Number(process.env.PORT ?? 8799);
// 上流の authMiddleware は `token === env.API_KEY` で判定するため、API_KEY が空だと "Bearer " だけで owner になる
if (!process.env.API_KEY) {
  console.error("API_KEY が未設定。空のまま起動すると無認証で owner 権限になるため中止する");
  process.exit(1);
}
const env = {
  DB: db as unknown as D1Database,
  IMAGES: images as unknown as R2Bucket,
  IG_APP_SECRET: process.env.IG_APP_SECRET ?? "",
  IG_ACCESS_TOKEN: process.env.IG_ACCESS_TOKEN ?? "",
  IG_USER_ID: process.env.IG_USER_ID ?? "",
  IG_VERIFY_TOKEN: process.env.IG_VERIFY_TOKEN ?? "",
  API_KEY: process.env.API_KEY ?? "",
  WORKER_URL: process.env.WORKER_URL ?? `http://localhost:${PORT}`,
  IG_USERNAME: process.env.IG_USERNAME,
  CONTACT_EMAIL: process.env.CONTACT_EMAIL,
  LINE_ADD_URL: process.env.LINE_ADD_URL,
  LINE_LIFF_ID: process.env.LINE_LIFF_ID,
  LINE_HARNESS_LINK_SECRET: process.env.LINE_HARNESS_LINK_SECRET,
} as Env["Bindings"];

const execCtx = {
  waitUntil(promise: Promise<unknown>) {
    promise.catch((err) => console.error("[waitUntil] Error:", err));
  },
  passThroughOnException() {},
} as unknown as ExecutionContext;

// ── Cron (Workers Cron Trigger の代替)。前回が長引いたら重ねて走らせない ──
let running = false;
async function runCron(): Promise<void> {
  if (running) {
    console.warn("[cron] previous run still in progress, skipped");
    return;
  }
  running = true;
  console.log(`[cron] start ${new Date().toISOString()}`);
  try {
    const event = { cron: "*/5 * * * *", type: "scheduled", scheduledTime: Date.now() } as unknown as ScheduledEvent;
    await worker.scheduled(event, env, execCtx);
    console.log("[cron] done");
  } catch (err) {
    console.error("[cron] Error:", err);
  } finally {
    running = false;
  }
}
cron.schedule("*/5 * * * *", runCron);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

serve(
  {
    // nginx 経由でしか公開しない。外から 8799 を直接叩かせない
    hostname: "127.0.0.1",
    port: PORT,
    fetch: async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      if (url.pathname === "/__scheduled" && req.method === "POST") {
        if (!env.API_KEY || req.headers.get("Authorization") !== `Bearer ${env.API_KEY}`) {
          return json(401, { success: false, error: "Unauthorized" });
        }
        await runCron();
        return json(200, { success: true, ranAt: new Date().toISOString() });
      }
      return worker.fetch(req, env, execCtx);
    },
  },
  (info) => {
    console.log(`IG Harness — Node.js Server\n  http://127.0.0.1:${info.port}\n  DB: ${DB_PATH}\n  Images: ${path.join(DATA_DIR, "images")}`);
  },
);
