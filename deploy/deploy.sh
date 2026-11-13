#!/usr/bin/env bash
# One-shot setup on an Ubuntu server with Nginx and Python 3.11+.
# Usage: sudo ./deploy/deploy.sh owner-reports.mhuzaifa.com
set -euo pipefail

DOMAIN="${1:?Pass the subdomain, e.g. owner-reports.mhuzaifa.com}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

# Frontend
mkdir -p /var/www/owner-reports
python3 "$SRC/scripts/generate_data.py"
rsync -a --delete "$SRC/frontend/" /var/www/owner-reports/

# Backend
mkdir -p /opt/owner-reports
rsync -a "$SRC/backend/" /opt/owner-reports/backend/ --exclude approvals.jsonl
python3 -m venv /opt/owner-reports/venv
/opt/owner-reports/venv/bin/pip install -q -r /opt/owner-reports/backend/requirements.txt
[ -f /opt/owner-reports/backend/.env ] || cp /opt/owner-reports/backend/.env.example /opt/owner-reports/backend/.env
chown -R www-data:www-data /opt/owner-reports/backend

# Services
sed "s/owner-reports.mhuzaifa.com/$DOMAIN/g" "$SRC/deploy/nginx.conf" > /etc/nginx/sites-available/owner-reports
ln -sf /etc/nginx/sites-available/owner-reports /etc/nginx/sites-enabled/owner-reports
cp "$SRC/deploy/owner-reports.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now owner-reports
systemctl restart owner-reports
nginx -t && systemctl reload nginx

echo "Now run: certbot --nginx -d $DOMAIN"
echo "Then set LLM_API_KEY in /opt/owner-reports/backend/.env and: systemctl restart owner-reports"
