#!/usr/bin/env bash
# Prepares the control box (Amazon Linux 2023) and installs the latest
# control bundle from S3. Safe to run again. Run it with `bun run deploy:control`.
set -euo pipefail

# shellcheck source=/dev/null
source /etc/substrate/control.env # AWS_REGION, PORT, SUBSTRATE_BUCKET, SUBSTRATE_HOST_INSTANCE_ID

log() { echo "[setup-control] $*"; }

id substrate >/dev/null 2>&1 || useradd --system --home-dir /var/lib/substrate --shell /sbin/nologin substrate
install -d -o substrate -g substrate /var/lib/substrate
install -d /opt/substrate/releases

# Secrets from Parameter Store (`bun run secrets`): how to reach hostd (the
# host's private IP, which it keeps across stops, and its token) and the Clerk
# keys. VMs stay off unless both are there.
secrets=/etc/substrate/control-secrets.env
param() { aws ssm get-parameter --region "$AWS_REGION" --name "$1" --with-decryption --query Parameter.Value --output text 2>/dev/null; }
(
  umask 077
  : >"${secrets}.tmp"
  if token=$(param /substrate/hostd-token); then
    host_ip=$(aws ec2 describe-instances --region "$AWS_REGION" --instance-ids "$SUBSTRATE_HOST_INSTANCE_ID" --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text)
    printf 'SUBSTRATE_HOSTD_URL=http://%s:7070\nSUBSTRATE_HOSTD_TOKEN=%s\n' "$host_ip" "$token" >>"${secrets}.tmp"
    log "hostd at ${host_ip}"
  else
    log "no /substrate/hostd-token in Parameter Store (run \`bun run secrets\`): VMs are off"
  fi
  if publishable=$(param /substrate/clerk-publishable-key) && secret=$(param /substrate/clerk-secret-key); then
    printf 'CLERK_PUBLISHABLE_KEY=%s\nCLERK_SECRET_KEY=%s\n' "$publishable" "$secret" >>"${secrets}.tmp"
    log "Clerk sign-in on"
  else
    log "no Clerk keys in Parameter Store (run \`bun run secrets --clerk\`): sign-in and VMs are off"
  fi
  mv "${secrets}.tmp" "$secrets"
)

cat >/etc/systemd/system/substrate-control.service <<'EOF'
[Unit]
Description=Substrate control API and web UI
After=network-online.target
Wants=network-online.target

[Service]
User=substrate
EnvironmentFile=/etc/substrate/control.env
EnvironmentFile=-/etc/substrate/control-secrets.env
Environment=HOME=/var/lib/substrate
Environment=SUBSTRATE_DB=/var/lib/substrate/control.db
WorkingDirectory=/opt/substrate/control
ExecStart=/opt/substrate/control/substrate-control
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/substrate

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable substrate-control >/dev/null 2>&1

# Unpack each release into its own folder, then switch a symlink to it, so the
# running service never sees a half-written bundle.
bundle_key=${SUBSTRATE_CONTROL_BUNDLE_KEY:-control/control.tar.gz}
if aws s3 cp --quiet "s3://${SUBSTRATE_BUCKET}/${bundle_key}" /tmp/control.tar.gz; then
  release="/opt/substrate/releases/$(date +%Y%m%d%H%M%S)"
  mkdir -p "$release"
  tar -xzf /tmp/control.tar.gz -C "$release"
  rm -f /tmp/control.tar.gz
  ln -sfn "$release" /opt/substrate/control
  log "installed $(cat "$release/VERSION")"
  # Keep the three newest releases.
  ls -1dt /opt/substrate/releases/* | tail -n +4 | xargs -r rm -rf
else
  log "no control bundle in s3://${SUBSTRATE_BUCKET}/control/ yet"
  exit 0
fi

if preview_origin=$(aws ssm get-parameter --region "$AWS_REGION" --name /substrate/preview-origin --query Parameter.Value --output text 2>/dev/null); then
  (umask 077 && printf 'SUBSTRATE_PREVIEW_ORIGIN=%s\n' "$preview_origin" >>"$secrets")
fi
# macOS workspaces (M10): the URL new Macs' agents dial in on.
if public_url=$(param /substrate/public-url); then
  (umask 077 && printf 'SUBSTRATE_PUBLIC_URL=%s\n' "$public_url" >>"$secrets")
fi

systemctl restart substrate-control
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
    log "healthy: $(curl -fsS "http://localhost:${PORT}/api/health")"
    exit 0
  fi
  sleep 1
done
log "substrate-control didn't become healthy"
journalctl -u substrate-control -n 30 --no-pager
exit 1
