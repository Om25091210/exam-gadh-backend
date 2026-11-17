#!/bin/bash
# RDS rotates its managed master password about weekly. Keep DATABASE_URL in api.env current and restart the API when it changes.
# Installed by server-deploy.sh as a systemd timer (every 10 minutes).
set -euo pipefail
cd /opt/examgadh
. ./db.conf   # DB_SECRET_ARN DB_HOST WEB_HOST ADMIN_HOST
export AWS_DEFAULT_REGION=ap-south-1
SEC=$(aws secretsmanager get-secret-value --secret-id "$DB_SECRET_ARN" --query SecretString --output text)
URL=$(python3 -c '
import json, sys, urllib.parse as u
s = json.loads(sys.argv[1])
print("postgresql://%s:%s@%s:5432/postgres?sslmode=require&connection_limit=10" % (u.quote(s["username"], safe=""), u.quote(s["password"], safe=""), sys.argv[2]))' "$SEC" "$DB_HOST")
CUR=$(grep '^DATABASE_URL=' api.env | cut -d= -f2- || true)
[ "$URL" = "$CUR" ] && exit 0
umask 077
{ grep -v '^DATABASE_URL=' api.env || true; printf 'DATABASE_URL=%s\n' "$URL"; } > api.env.new
mv api.env.new api.env
export WEB_HOST ADMIN_HOST
docker compose up -d --force-recreate api
echo "database password changed: API restarted"
