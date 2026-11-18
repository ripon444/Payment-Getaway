#!/usr/bin/env bash
set -euo pipefail

# TakaLedger Automated MySQL 8 Backup Script (Cron-ready)
# Example crontab: 0 2 * * * /opt/takaledger/deploy/backup-mysql.sh >> /var/log/takaledger-backup.log 2>&1

BACKUP_DIR="${BACKUP_DIR:-/var/backups/takaledger-mysql}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
ENV_FILE="${ENV_FILE:-/opt/takaledger/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

MYSQL_HOST="${MYSQL_HOST:-127.0.0.1}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
MYSQL_USER="${MYSQL_USER:-takaledger}"
MYSQL_DATABASE="${MYSQL_DATABASE:-takaledger_gateway}"

if [[ -z "${MYSQL_PASSWORD:-}" ]]; then
  echo "[ERROR] MYSQL_PASSWORD is not set." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%d_%H%M%SZ)"
OUT_FILE="${BACKUP_DIR}/${MYSQL_DATABASE}_${STAMP}.sql.gz"

export MYSQL_PWD="$MYSQL_PASSWORD"
mysqldump \
  --host="$MYSQL_HOST" \
  --port="$MYSQL_PORT" \
  --user="$MYSQL_USER" \
  --single-transaction \
  --routines \
  --triggers \
  --events \
  --set-gtid-purged=OFF \
  "$MYSQL_DATABASE" | gzip -9 > "$OUT_FILE"
unset MYSQL_PWD

sha256sum "$OUT_FILE" > "${OUT_FILE}.sha256"
chmod 600 "$OUT_FILE" "${OUT_FILE}.sha256"

# Verify gzip integrity
gzip -t "$OUT_FILE"

# Prune backups older than retention window
find "$BACKUP_DIR" -type f \( -name "*.sql.gz" -o -name "*.sha256" \) -mtime "+${RETENTION_DAYS}" -delete

echo "[OK] Backup created & verified: ${OUT_FILE}"
