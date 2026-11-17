#!/bin/bash
# Runs ON the app server through SSM Run Command. Usage: server-deploy.sh <media-bucket> <web-host> <admin-host>
set -euo pipefail
BUCKET=$1; WEB_HOST=$2; ADMIN_HOST=$3
export AWS_DEFAULT_REGION=ap-south-1
cd /opt/examgadh

# the build needs memory: make sure there is swap on small instances
if ! swapon --show | grep -q swapfile; then
  fallocate -l 3G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
fi

# runtime configuration comes from Parameter Store (secrets never live in the repo or the image)
p() { aws ssm get-parameter --with-decryption --name "/examgadh/dev/$1" --query Parameter.Value --output text; }
umask 077
cat > api.env <<ENVEOF
NODE_ENV=production
PORT=3000
DATABASE_URL=$(p database_url)
JWT_SECRET=$(p jwt_secret)
ADMIN_TOTP_KEY=$(p admin_totp_key)
GOOGLE_CLIENT_IDS=$(p google_client_ids)
RAZORPAY_KEY_ID=$(p razorpay_key_id)
RAZORPAY_KEY_SECRET=$(p razorpay_key_secret)
RAZORPAY_WEBHOOK_SECRET=$(p razorpay_webhook_secret)
CORS_ORIGINS=https://$WEB_HOST,https://$ADMIN_HOST
MEDIA_BUCKET=$BUCKET
AWS_REGION=ap-south-1
LOG_LEVEL=info
# TEMPORARY testing switch (SSM /examgadh/dev/admin_testing_login = true): staff sign in with e-mail + password only
ADMIN_TESTING_LOGIN=$(p admin_testing_login 2>/dev/null || echo false)
ENVEOF
umask 022

# keep the database password current (RDS rotates it): config + a systemd timer that runs refresh-db-url.sh
cat > db.conf <<CONFEOF
DB_SECRET_ARN=$(p db_secret_arn)
DB_HOST=$(p db_host)
WEB_HOST=$WEB_HOST
ADMIN_HOST=$ADMIN_HOST
CONFEOF

for src in backend frontend; do
  rm -rf "src-$src" && mkdir "src-$src"
  aws s3 cp "s3://$BUCKET/deploy/$src.tgz" - | tar xz -C "src-$src"
done
cp src-backend/deploy/docker-compose.yml src-backend/deploy/Caddyfile src-backend/deploy/refresh-db-url.sh .
chmod +x refresh-db-url.sh
cat > /etc/systemd/system/examgadh-db-refresh.service <<'UNITEOF'
[Unit]
Description=Refresh the ExamGadh database password in api.env
[Service]
Type=oneshot
ExecStart=/opt/examgadh/refresh-db-url.sh
UNITEOF
cat > /etc/systemd/system/examgadh-db-refresh.timer <<'UNITEOF'
[Unit]
Description=Check the database password every 10 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
[Install]
WantedBy=timers.target
UNITEOF
systemctl daemon-reload && systemctl enable --now examgadh-db-refresh.timer

docker build -t examgadh-api-build --target build src-backend
docker build -t examgadh-api src-backend
docker run --rm --env-file api.env examgadh-api-build pnpm prisma migrate deploy
GCI=$(grep "^GOOGLE_CLIENT_IDS=" api.env | cut -d= -f2 | cut -d, -f1); case "$GCI" in unset.*) GCI="";; esac
docker build -t examgadh-web --build-arg APP=web --build-arg NEXT_PUBLIC_GOOGLE_CLIENT_ID="$GCI" src-frontend
docker build -t examgadh-admin --build-arg APP=admin src-frontend

export WEB_HOST ADMIN_HOST
docker compose up -d --remove-orphans
docker image prune -f >/dev/null
docker compose ps
