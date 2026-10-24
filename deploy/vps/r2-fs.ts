/**
 * R2Bucket 互換の薄い層（ローカルファイルシステム保存）。
 *
 * apps/worker/src/routes/images.ts が使う put / get(range) / head / list(delimiter) / delete だけを実装する。
 * 本物の R2 を VPS から叩く案は採らなかった: 画像配信が外部依存になり、Meta が取りに来る URL の死活が増えるため。
 * メタデータは本体ファイルの横の `<key>.meta.json` に置く（本体を壊さず、list 時に除外しやすい）。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const META_SUFFIX = ".meta.json";

interface StoredMeta {
  contentType?: string;
  customMetadata?: Record<string, string>;
}

interface PutOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

interface R2ObjectLike {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  httpMetadata: { contentType?: string };
  customMetadata: Record<string, string>;
}

interface R2ObjectBodyLike extends R2ObjectLike {
  body: Uint8Array;
}

export function createFsBucket(rootDir: string) {
  const root = path.resolve(rootDir);
  fs.mkdirSync(root, { recursive: true });

  // key は URL パラメータ由来。root の外に出る指定（.. や絶対パス）は存在しない扱いにする。
  function resolveKey(key: string): string | null {
    if (!key || key.includes("\0") || key.endsWith(META_SUFFIX)) return null;
    const full = path.resolve(root, key);
    return full.startsWith(root + path.sep) ? full : null;
  }

  function readMeta(file: string): StoredMeta {
    try {
      return JSON.parse(fs.readFileSync(file + META_SUFFIX, "utf-8")) as StoredMeta;
    } catch {
      return {};
    }
  }

  function toObject(key: string, file: string, stat: fs.Stats): R2ObjectLike {
    const meta = readMeta(file);
    return {
      key,
      size: stat.size,
      // 内容ハッシュではなく size+mtime。immutable キャッシュの検証用途で、画像は UUID 名で上書きされない
      etag: createHash("md5").update(`${stat.size}-${stat.mtimeMs}`).digest("hex"),
      uploaded: stat.mtime,
      httpMetadata: { contentType: meta.contentType },
      customMetadata: meta.customMetadata ?? {},
    };
  }

  return {
    async put(key: string, data: ArrayBuffer | Uint8Array, options?: PutOptions): Promise<void> {
      const file = resolveKey(key);
      if (!file) throw new Error(`invalid key: ${key}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data instanceof Uint8Array ? data : new Uint8Array(data));
      const meta: StoredMeta = {
        contentType: options?.httpMetadata?.contentType,
        customMetadata: options?.customMetadata,
      };
      fs.writeFileSync(file + META_SUFFIX, JSON.stringify(meta));
    },

    async head(key: string): Promise<R2ObjectLike | null> {
      const file = resolveKey(key);
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
      return toObject(key, file, fs.statSync(file));
    },

    async get(
      key: string,
      options?: { range?: { offset: number; length: number } },
    ): Promise<R2ObjectBodyLike | null> {
      const file = resolveKey(key);
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
      const stat = fs.statSync(file);
      const whole = fs.readFileSync(file);
      const body = options?.range
        ? whole.subarray(options.range.offset, options.range.offset + options.range.length)
        : whole;
      // Range 指定でも size は「全体のサイズ」を返す（本物の R2 と同じ。images.ts がこの前提で Content-Range を組む）
      return { ...toObject(key, file, stat), body };
    },

    async list(options?: {
      limit?: number;
      cursor?: string;
      delimiter?: string;
    }): Promise<{
      objects: R2ObjectLike[];
      truncated: boolean;
      cursor?: string;
      delimitedPrefixes: string[];
    }> {
      const limit = options?.limit ?? 1000;
      const entries = fs.readdirSync(root, { withFileTypes: true });
      const prefixes = entries
        .filter((e) => e.isDirectory())
        .map((e) => `${e.name}/`)
        .sort();
      const files = entries
        .filter((e) => e.isFile() && !e.name.endsWith(META_SUFFIX))
        .map((e) => e.name)
        .sort()
        .filter((name) => !options?.cursor || name > options.cursor);

      const page = files.slice(0, limit);
      const truncated = files.length > limit;
      const objects = page.map((name) => toObject(name, path.join(root, name), fs.statSync(path.join(root, name))));
      return {
        objects,
        truncated,
        cursor: truncated ? page[page.length - 1] : undefined,
        delimitedPrefixes: prefixes,
      };
    },

    async delete(key: string): Promise<void> {
      const file = resolveKey(key);
      if (!file) return;
      fs.rmSync(file, { force: true });
      fs.rmSync(file + META_SUFFIX, { force: true });
    },
  };
}
