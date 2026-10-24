#!/bin/bash
# 現在のブランチを VPS へ反映する（初回インストールも更新も同じ手順）。--delete は使わない。
# 使い方: bash deploy/vps/deploy.sh [YYYYMMDD]   （バックアップ名の日付。既定は今日。同名があれば中止）
# 前提: 初回は先に `bash deploy/vps/make-env.sh` で .env を置く
# 反映しないもの: .env、data/（DB・画像）、node_modules
set -u
DATE=${1:-$(date +%Y%m%d)}
R=$(cd "$(dirname "$0")/../.." && pwd)
T=$(mktemp -d)/deploy-tree
SSH_HOST=xserver-vps
SSH="ssh -o BatchMode=yes $SSH_HOST"
DEST=/opt/ig-harness
BAK=/opt/ig-harness-bak-$DATE
CONF=/etc/nginx/conf.d/sakuraent.conf

cd "$R" || exit 1
echo "branch: $(git branch --show-current)"
[ -z "$(git status --short)" ] || { echo "未コミットの変更あり。中止"; git status --short | head; exit 1; }
echo "deploying commit: $(git log --oneline -1 | cut -c1-80)"
$SSH "test -e $DEST/apps/worker/.env" || { echo ".env が無い。先に make-env.sh を実行して"; exit 1; }

echo; echo "[1] 管理画面を basePath 付きでビルド（ビルド後に設定を元へ戻す）"
# 上流の next.config.ts には basePath が無い。nginx は /ig-harness-admin/ 配下でしか配信しないため、無いと JS/CSS が 404 で白画面になる
python3 - "$R" <<'PY'
import sys, os
p = os.path.join(sys.argv[1], "apps/web/next.config.ts")
s = open(p).read()
if "basePath" not in s:
    s = s.replace("output: 'export',", "output: 'export',\n  basePath: '/ig-harness-admin',\n  assetPrefix: '/ig-harness-admin',")
open(p, "w").write(s)
PY
NEXT_PUBLIC_API_URL=https://sakuraent.net/ig-harness pnpm --filter web build > "${TMPDIR:-/tmp}/ig-deploy-web.log" 2>&1
BUILD=$?
git checkout -- apps/web/next.config.ts
echo "web build exit=$BUILD / next.config.ts restored (dirty=$(git status --short | wc -l | tr -d ' '))"
[ "$BUILD" = 0 ] || { tail -5 "${TMPDIR:-/tmp}/ig-deploy-web.log"; exit 1; }
grep -q '/ig-harness-admin/_next/' apps/web/out/index.html || { echo "basePath が反映されていない"; exit 1; }

echo; echo "[2] 反映するソースをコミットから取り出す"
mkdir -p "$T"
git archive HEAD | tar -x -C "$T"
cp "$T/deploy/vps/d1-adapter.ts" "$T/apps/worker/src/d1-adapter.ts"
cp "$T/deploy/vps/r2-fs.ts"      "$T/apps/worker/src/r2-fs.ts"
cp "$T/deploy/vps/server.ts"     "$T/apps/worker/src/server.ts"

echo; echo "[3] 既存があればバックアップ（DB は .backup、ソースは cp -a。画像は data/ に残るので対象外）"
$SSH "set -e
if [ -d $DEST/apps/worker/src ]; then
  [ ! -e $BAK ] || { echo 'bak already exists'; exit 1; }
  mkdir -p $BAK
  if [ -f $DEST/apps/worker/data/ig-harness.sqlite ]; then
    sqlite3 $DEST/apps/worker/data/ig-harness.sqlite \".backup '$BAK/ig-harness.sqlite'\"
  fi
  cp -a $DEST/apps/worker/src $BAK/worker-src
  cp -a $DEST/packages $BAK/packages
  [ -d $DEST/apps/web/out ] && cp -a $DEST/apps/web/out $BAK/web-out
  chmod -R go-rwx $BAK
  echo \"backup: \$(du -sh $BAK | cut -f1)\"
else
  echo '初回インストール（バックアップ対象なし）'
fi"
[ $? = 0 ] || { echo "backup failed"; exit 1; }

echo; echo "[4] 反映（--delete なし。.env / data / node_modules は触らない）"
rsync -az --exclude='.env' --exclude='data/' --exclude='node_modules/' --exclude='.git/' --exclude='docs/' \
  "$T/" "$SSH_HOST:$DEST/" && echo "source synced"
$SSH "mkdir -p $DEST/apps/web/out"
rsync -az "$R/apps/web/out/" "$SSH_HOST:$DEST/apps/web/out/" && echo "admin out/ synced"

echo; echo "[5] 依存インストールと SDK ビルド（VPS 上。better-sqlite3 は VPS 側でビルドされる）"
$SSH "cd $DEST && pnpm install --frozen-lockfile --filter 'worker...' 2>&1 | tail -3 && pnpm --filter @ig-harness/shared --filter @ig-harness/ig-sdk build 2>&1 | tail -3"
# pnpm 10 は依存の postinstall を既定で止める。better-sqlite3 のネイティブ .node が無いと起動で落ちるので実在を確かめる
$SSH "ls $DEST/node_modules/.pnpm/better-sqlite3*/node_modules/better-sqlite3/build/Release/better_sqlite3.node" || { echo "better-sqlite3 のネイティブビルドが無い"; exit 1; }

echo; echo "[6] systemd ユニット（未登録なら登録）"
scp -q "$T/deploy/vps/ig-harness.service" "$SSH_HOST:/tmp/ig-harness.service"
$SSH "[ -f /etc/systemd/system/ig-harness.service ] || { cp /tmp/ig-harness.service /etc/systemd/system/ig-harness.service && systemctl daemon-reload && systemctl enable ig-harness; echo 'unit installed'; }; rm -f /tmp/ig-harness.service"

echo; echo "[7] nginx（ig-harness が未登録なら x-harness-admin の直前へ挿入。nginx -t が失敗したら元に戻す）"
scp -q "$T/deploy/vps/nginx-locations.conf" "$SSH_HOST:/tmp/ig-nginx-locations.conf"
$SSH "set -e
if grep -q 'location /ig-harness/' $CONF; then
  echo 'nginx: 既に登録済み'
else
  cp -a $CONF $CONF.bak-ig-$DATE
  python3 - <<'PY'
conf = '$CONF'
s = open(conf).read()
block = open('/tmp/ig-nginx-locations.conf').read()
marker = '    location = /x-harness-admin {'
assert s.count(marker) == 1, 'marker not unique'
open(conf, 'w').write(s.replace(marker, block + marker))
PY
  if nginx -t 2>/dev/null; then systemctl reload nginx && echo 'nginx: 挿入して reload'; else cp -a $CONF.bak-ig-$DATE $CONF; nginx -t; echo 'nginx: 検証失敗、元に戻した'; exit 1; fi
fi
rm -f /tmp/ig-nginx-locations.conf"

echo; echo "[8] 再起動して検証"
$SSH "systemctl restart ig-harness; sleep 7; echo active=\$(systemctl is-active ig-harness)"
echo "health(no-auth, 401 が正): $(curl -s -o /dev/null -m 10 -w '%{http_code}' https://sakuraent.net/ig-harness/api/health)"
echo "admin: $(curl -s -o /dev/null -m 10 -w '%{http_code}' https://sakuraent.net/ig-harness-admin/)"
echo "privacy-policy(公開, 200 が正): $(curl -s -o /dev/null -m 10 -w '%{http_code}' https://sakuraent.net/ig-harness/privacy-policy)"
$SSH "journalctl -u ig-harness --since '-1min' --no-pager | grep -E 'migrate\] (Applying|.*FAILED)|Error|error|Node.js Server' | cut -c1-160 | tail -8
echo \"migrations: \$(sqlite3 $DEST/apps/worker/data/ig-harness.sqlite 'select count(*), max(name) from _applied_migrations;')\""
