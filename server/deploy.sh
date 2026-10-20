#!/usr/bin/env bash
# Разворачивает сервер-пересыльщик в Yandex Cloud. Можно запускать повторно:
# существующие ресурсы не пересоздаются, обновляется только код функции и шлюз.
# Нужны: yc, jq, zip и IAM-токен в YC_IAM_TOKEN, ID деплой-аккаунта в YC_SA_ID.
set -euo pipefail
cd "$(dirname "$0")"

y() { yc "$@" --token "$YC_IAM_TOKEN"; }

FOLDER_ID=$(y iam service-account get --id "$YC_SA_ID" --format json | jq -r .folder_id)
echo "Каталог: $FOLDER_ID"
yf() { y "$@" --folder-id "$FOLDER_ID"; }

# --- Сервисный аккаунт, от имени которого работает сервер -------------------
SA_NAME=bred-relay-sa
SA_ID=$(yf iam service-account get --name "$SA_NAME" --format json 2>/dev/null | jq -r '.id // empty' || true)
if [ -z "$SA_ID" ]; then
  SA_ID=$(yf iam service-account create --name "$SA_NAME" --description "Бредовуха: сервер-пересыльщик" --format json | jq -r .id)
  echo "Создан сервисный аккаунт $SA_ID"
fi
for role in ydb.editor api-gateway.websocketWriter functions.functionInvoker; do
  y resource-manager folder add-access-binding --id "$FOLDER_ID" --role "$role" --service-account-id "$SA_ID" >/dev/null 2>&1 \
    && echo "Роль $role выдана" || echo "Роль $role уже есть"
done

# --- База YDB (serverless) ----------------------------------------------------
DB_NAME=bred-db
DB_JSON=$(yf ydb database get --name "$DB_NAME" --format json 2>/dev/null || true)
if [ -z "$DB_JSON" ]; then
  echo "Создаю базу YDB…"
  DB_JSON=$(yf ydb database create --name "$DB_NAME" --serverless --format json)
fi
YDB_FULL=$(echo "$DB_JSON" | jq -r .endpoint)
YDB_ENDPOINT=${YDB_FULL%%/?database=*}
YDB_DATABASE=${YDB_FULL##*database=}
echo "YDB: $YDB_ENDPOINT $YDB_DATABASE"

# --- Функция ------------------------------------------------------------------
FN_NAME=bred-relay
FN_ID=$(yf serverless function get --name "$FN_NAME" --format json 2>/dev/null | jq -r '.id // empty' || true)
if [ -z "$FN_ID" ]; then
  FN_ID=$(yf serverless function create --name "$FN_NAME" --format json | jq -r .id)
  echo "Создана функция $FN_ID"
fi

rm -f /tmp/relay.zip
(cd relay && zip -q -r /tmp/relay.zip index.js package.json)

version_create() {
  yf serverless function version create \
    --function-id "$FN_ID" \
    --runtime "$1" \
    --entrypoint index.handler \
    --memory 128m \
    --execution-timeout 10s \
    --service-account-id "$SA_ID" \
    --environment "YDB_ENDPOINT=$YDB_ENDPOINT" \
    --environment "YDB_DATABASE=$YDB_DATABASE" \
    --source-path /tmp/relay.zip
}
version_create nodejs22 || { echo "nodejs22 недоступен, пробую nodejs18"; version_create nodejs18; }

# --- API Gateway с WebSocket --------------------------------------------------
GW_NAME=bred-relay-gw
cat > /tmp/gw.yaml <<EOF
openapi: 3.0.0
info:
  title: bred-relay
  version: 1.0.0
paths:
  /ws:
    x-yc-apigateway-websocket-message:
      x-yc-apigateway-integration:
        type: cloud_functions
        function_id: $FN_ID
        tag: "\$latest"
        service_account_id: $SA_ID
EOF
GW_JSON=$(yf serverless api-gateway get --name "$GW_NAME" --format json 2>/dev/null || true)
if [ -z "$GW_JSON" ]; then
  GW_JSON=$(yf serverless api-gateway create --name "$GW_NAME" --spec /tmp/gw.yaml --format json)
  echo "Создан шлюз"
else
  GW_JSON=$(yf serverless api-gateway update --name "$GW_NAME" --spec /tmp/gw.yaml --format json)
fi
DOMAIN=$(echo "$GW_JSON" | jq -r .domain)
echo "RELAY_URL=wss://$DOMAIN/ws"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "RELAY_URL: \`wss://$DOMAIN/ws\`" >> "$GITHUB_STEP_SUMMARY"; fi
