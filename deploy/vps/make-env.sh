#!/bin/bash
# 初回だけ: VPS の apps/worker/.env を作る。API_KEY と Webhook 検証トークンはここで生成して Vault に控える。
# Meta 側の値（IG_APP_SECRET / IG_ACCESS_TOKEN / IG_USER_ID）は Meta Developer での作業後に別途入れる（空でも起動する）。
# 使い方: bash deploy/vps/make-env.sh
set -eu
SSH_HOST=xserver-vps
ENV_PATH=/opt/ig-harness/apps/worker/.env
WORK=$(mktemp -d)
# 平文の API_KEY を含むので、成功・失敗どちらでも必ず消す
trap 'rm -rf "$WORK"' EXIT

if ssh -o BatchMode=yes "$SSH_HOST" "test -e $ENV_PATH"; then
  echo "既に $ENV_PATH がある。上書きしない（中止）"
  exit 1
fi

API_KEY=$(openssl rand -hex 32)
VERIFY=$(openssl rand -hex 16)

# Vault に先に控える。控えに失敗 or 照合が合わなければ VPS には何も置かない（キーを失わないため）
secret set IG_HARNESS_API_KEY "$API_KEY" --folder=api
secret set IG_HARNESS_VERIFY_TOKEN "$VERIFY" --folder=api
STORED=$(secret get IG_HARNESS_API_KEY)
if [ "$STORED" != "$API_KEY" ]; then
  echo "Vault 控えの照合に失敗。中止"
  exit 1
fi

umask 077
{
  echo "PORT=8799"
  echo "API_KEY=$API_KEY"
  echo "WORKER_URL=https://sakuraent.net/ig-harness"
  echo "IG_VERIFY_TOKEN=$VERIFY"
  echo "IG_APP_SECRET="
  echo "IG_ACCESS_TOKEN="
  echo "IG_USER_ID="
} > "$WORK/.env"

ssh -o BatchMode=yes "$SSH_HOST" "mkdir -p /opt/ig-harness/apps/worker"
scp -q "$WORK/.env" "$SSH_HOST:$ENV_PATH"
ssh -o BatchMode=yes "$SSH_HOST" "chmod 600 $ENV_PATH && ls -l $ENV_PATH"
echo "OK. Vault: IG_HARNESS_API_KEY / IG_HARNESS_VERIFY_TOKEN"
