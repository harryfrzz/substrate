#!/bin/bash
# Prepares a new EC2 Mac host (macOS on Apple silicon) for macOS workspaces:
# tart and softnet, the base VM image, and macd as a LaunchDaemon. Runs once,
# as root, from the first-boot user data (apps/control/src/macs/user-data.ts),
# which sets SUBSTRATE_BUCKET, SUBSTRATE_BUCKET_REGION, SUBSTRATE_CONTROL_URL,
# SUBSTRATE_MAC_TOKEN and SUBSTRATE_MAC_BASE_IMAGE. Its log is
# /var/log/substrate-setup.log.
set -euo pipefail

log() { echo "[setup-mac] $(date -u +%H:%M:%S) $*"; }
as_user() { sudo -u ec2-user -H env PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_INSTALL_CLEANUP=1 "$@"; }
retry() { for attempt in 1 2 3; do "$@" && return 0; log "attempt ${attempt} failed: $*"; sleep 30; done; return 1; }

# The AMI's APFS container is smaller than the EBS volume; grow it to fill it,
# since the base image alone takes 50 GB or so.
log "growing the root container"
if [ -x /usr/local/bin/ec2-macos-utils ]; then
  /usr/local/bin/ec2-macos-utils grow --id root || log "couldn't grow the root container"
else
  disk=$(diskutil list physical external | head -n1 | cut -d' ' -f1)
  container=$(diskutil list physical external | grep Apple_APFS | tr -s ' ' | cut -d' ' -f8)
  { yes | diskutil repairDisk "$disk" && diskutil apfs resizeContainer "$container" 0; } || log "couldn't grow the root container"
fi

# tart runs the VMs; softnet keeps each VM to itself and the internet, away
# from the other VM and this Mac's network. softnet needs root (the SUID bit).
log "installing tart and softnet"
retry as_user brew install cirruslabs/cli/tart cirruslabs/cli/softnet
softnet=$(readlink -f /opt/homebrew/bin/softnet)
chown root:wheel "$softnet"
chmod u+s "$softnet"

# The base image is big; pulling it now means the Mac's first workspace only
# has to clone it.
log "pulling ${SUBSTRATE_MAC_BASE_IMAGE}"
retry as_user tart pull "$SUBSTRATE_MAC_BASE_IMAGE"

log "installing macd"
install -d -m 755 /opt/substrate
aws s3 cp --quiet --region "$SUBSTRATE_BUCKET_REGION" "s3://${SUBSTRATE_BUCKET}/mac/substrate-macd" /opt/substrate/substrate-macd
chmod 755 /opt/substrate/substrate-macd
# Apple silicon runs signed code only; an ad-hoc signature is enough.
codesign --force --sign - /opt/substrate/substrate-macd

# The agent token is in here, so only ec2-user (whom macd runs as) can read it.
(
  umask 077
  printf 'SUBSTRATE_CONTROL_URL=%s\nSUBSTRATE_MAC_TOKEN=%s\nSUBSTRATE_MAC_BASE_IMAGE=%s\n' \
    "$SUBSTRATE_CONTROL_URL" "$SUBSTRATE_MAC_TOKEN" "$SUBSTRATE_MAC_BASE_IMAGE" >/opt/substrate/macd.env
)
chown ec2-user:staff /opt/substrate/macd.env
touch /var/log/substrate-macd.log
chown ec2-user:staff /var/log/substrate-macd.log

# AbandonProcessGroup: VMs keep running while macd restarts.
cat >/Library/LaunchDaemons/dev.substrate.macd.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.substrate.macd</string>
  <key>UserName</key><string>ec2-user</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string><string>-c</string>
    <string>set -a; . /opt/substrate/macd.env; exec /opt/substrate/substrate-macd</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>/Users/ec2-user</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>/var/log/substrate-macd.log</string>
  <key>StandardErrorPath</key><string>/var/log/substrate-macd.log</string>
</dict>
</plist>
PLIST
chmod 644 /Library/LaunchDaemons/dev.substrate.macd.plist
launchctl bootout system/dev.substrate.macd 2>/dev/null || true
launchctl bootstrap system /Library/LaunchDaemons/dev.substrate.macd.plist
log "macd is running; it dials ${SUBSTRATE_CONTROL_URL}"
