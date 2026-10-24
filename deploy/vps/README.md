# VPS 固有の移植層

上流（Cloudflare Workers + D1 + R2 + Durable Object 前提）を、VPS の Node.js で動かすための差分。
上流には無いので、**上流を更新するたびにここを当て直す**（`deploy.sh` が `apps/worker/src/` へコピーする）。

| ファイル | 役割 |
|---|---|
| `server.ts` | Node 起動、DB 初期化、migration 適用、cron（5 分毎）、`/__scheduled` 手動トリガ |
| `d1-adapter.ts` | D1 互換（better-sqlite3）。`bind` は新しい statement を返し、`batch` はトランザクション |
| `r2-fs.ts` | R2 互換（`data/images/` のファイル保存）。`put/get(range)/head/list(delimiter)/delete` のみ |
| `ig-harness.service` | systemd ユニット（port 8799、127.0.0.1 のみ listen） |
| `nginx-locations.conf` | `/ig-harness/`（API・Webhook・画像）と `/ig-harness-admin/`（管理画面） |
| `make-env.sh` | 初回のみ。API_KEY と Webhook 検証トークンを生成 → Vault に控え → VPS へ `.env` 配置 |
| `deploy.sh` | 管理画面ビルド → バックアップ → `--delete` なしで反映 → 依存/SDK ビルド → 再起動 → 検証 |

## 上流との差分（ブランチ `vps/node-port`）
- `apps/worker/package.json`: `start = tsx src/server.ts` と Node 用依存を追加
- `package.json`: `start`、`pnpm.onlyBuiltDependencies`（pnpm 10 で better-sqlite3 のネイティブビルドを通す）
- `packages/db/package.json`: `"type": "module"`（無いと tsx が CJS 扱いにして `export *` の名前を解決できない）

## 初回
```
bash deploy/vps/make-env.sh   # .env 生成 + Vault 控え
bash deploy/vps/deploy.sh     # 反映
```
Meta の値（`IG_APP_SECRET` / `IG_ACCESS_TOKEN` / `IG_USER_ID`）は空でも起動する。入れるまで Webhook は検証で弾かれ、DM は動かない。

## 落とし穴（実害あり）
- **migration は文単位で流す**。`schema.sql` は migration を途中まで取り込んだ状態で、既にある列への `ALTER` が必ず重複エラーになる。
  ファイル単位で丸ごと skip にすると、同じファイルの後続の文（`0014` の `comment_rules.account_id`）が黙って未適用になる
- `API_KEY` が空だと上流の認証は `Bearer `（空）で通る。`server.ts` は空なら起動しない
- 管理画面の `basePath` を忘れると JS/CSS が全部 404 で白画面。`deploy.sh` がビルド時だけ足して戻す（コミットしない）
- `data/`（DB・画像）は絶対に同期しない。`rsync --delete` も使わない

## Meta 側に設定する URL
- Webhook コールバック: `https://sakuraent.net/ig-harness/webhook`（検証トークンは Vault `IG_HARNESS_VERIFY_TOKEN`）
- プライバシーポリシー: `https://sakuraent.net/ig-harness/privacy-policy`
- 利用規約: `https://sakuraent.net/ig-harness/terms-of-service`
- データ削除: `https://sakuraent.net/ig-harness/data-deletion`
