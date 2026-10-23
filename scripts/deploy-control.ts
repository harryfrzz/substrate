// Builds the web app and the control API, ships them to the control box, and
// waits for the public URL to serve the new version.
import { $ } from 'bun'
import { cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { printRun, run, stackOutputs, upload } from './lib/aws.ts'

const root = join(import.meta.dir, '..')
const out = await stackOutputs()
const version = (await $`git describe --always --dirty`.cwd(root).text()).trim()
const artifactPrefix = `control/releases/${randomUUID()}`
const bundle = join(root, 'dist/control')

console.log(`building ${version}`)
await rm(bundle, { recursive: true, force: true })
await mkdir(bundle, { recursive: true })
await $`bun run build`.cwd(join(root, 'apps/web')).quiet()
await cp(join(root, 'apps/web/dist'), join(bundle, 'web'), { recursive: true })
await $`bun build --compile --minify --target=bun-linux-arm64 --define ${`BUILD_VERSION=${JSON.stringify(version)}`} src/index.ts --outfile ${join(bundle, 'substrate-control')}`
  .cwd(join(root, 'apps/control'))
  .quiet()
await Bun.write(join(bundle, 'VERSION'), `${version}\n`)
// macd, for new Macs (M10); they fetch it at first boot, so it ships with the
// control box that speaks its protocol.
const macd = join(root, 'dist/substrate-macd')
await $`bun build --compile --minify --target=bun-darwin-arm64 --define ${`BUILD_VERSION=${JSON.stringify(version)}`} src/index.ts --outfile ${macd}`
  .cwd(join(root, 'apps/macd'))
  .quiet()
const tarball = join(root, 'dist/control.tar.gz')
// macOS tar would otherwise add Apple xattrs that GNU tar warns about on the box.
await $`tar --no-xattrs -czf ${tarball} -C ${bundle} .`.env({ ...process.env, COPYFILE_DISABLE: '1' })

console.log('uploading')
await upload(out.ArtifactsBucket, `${artifactPrefix}/control.tar.gz`, await Bun.file(tarball).bytes())
await upload(
  out.ArtifactsBucket,
  `${artifactPrefix}/setup-control.sh`,
  await Bun.file(join(root, 'images/control/setup-control.sh')).text(),
)

console.log('installing on the control box')
const result = await run(
  out.ControlInstanceId,
  [
    'set -e',
    'exec 9>/run/lock/substrate-control-deploy.lock',
    'flock -n 9 || { echo "Another control deployment is active" >&2; exit 1; }',
    'mkdir -p /opt/substrate',
    `aws s3 cp --quiet s3://${out.ArtifactsBucket}/${artifactPrefix}/setup-control.sh /opt/substrate/setup-control.sh`,
    `SUBSTRATE_CONTROL_BUNDLE_KEY=${artifactPrefix}/control.tar.gz bash /opt/substrate/setup-control.sh`,
  ].join('\n'),
)
printRun(result)
if (!result.ok) {
  console.error(`install failed (${result.status})`)
  process.exit(1)
}

// A brand-new CloudFront distribution can take a few minutes to reach every edge.
console.log(`checking ${out.Url}`)
const deadline = Date.now() + 10 * 60_000
for (;;) {
  const health = await fetch(`${out.Url}/api/health`)
    .then((r) => (r.ok ? (r.json() as Promise<{ version: string }>) : null))
    .catch(() => null)
  if (health?.version === version) break
  if (Date.now() > deadline) {
    console.error(`${out.Url} isn't serving ${version} yet`)
    process.exit(1)
  }
  await Bun.sleep(10_000)
}
// Only once the control box is live, so new Macs never get a macd newer
// than the control box they dial.
await upload(out.ArtifactsBucket, 'mac/substrate-macd', await Bun.file(macd).bytes())
await upload(out.ArtifactsBucket, 'mac/setup-mac.sh', await Bun.file(join(root, 'images/mac/setup-mac.sh')).text())
console.log(`live: ${out.Url}`)
