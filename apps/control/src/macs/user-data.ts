// What a new Mac runs as root at first boot (EC2 user data): fetch the setup
// script from the artifacts bucket (in Mumbai) and run it. The agent token is
// in here, so the instance's metadata service is kept out of its VMs' reach
// (see cloud.ts).
export function macUserData({ bucket, bucketRegion, controlUrl, token, baseImage }: {
  bucket: string
  bucketRegion: string
  controlUrl: string
  token: string
  baseImage: string
}) {
  const env = { SUBSTRATE_BUCKET: bucket, SUBSTRATE_BUCKET_REGION: bucketRegion, SUBSTRATE_CONTROL_URL: controlUrl, SUBSTRATE_MAC_TOKEN: token, SUBSTRATE_MAC_BASE_IMAGE: baseImage }
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z0-9:/._@+=-]+$/.test(value)) throw new Error(`${key} has characters a shell script can't take as is`)
  }
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    'export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    ...Object.entries(env).map(([key, value]) => `export ${key}='${value}'`),
    'mkdir -p /opt/substrate',
    'aws s3 cp --quiet --region "$SUBSTRATE_BUCKET_REGION" "s3://$SUBSTRATE_BUCKET/mac/setup-mac.sh" /opt/substrate/setup-mac.sh',
    'bash /opt/substrate/setup-mac.sh >>/var/log/substrate-setup.log 2>&1',
    '',
  ].join('\n')
}
