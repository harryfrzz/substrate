# Developing Substrate

Read [plan.md](plan.md) first: it has the milestones, the design, and the ground
rules (TypeScript wherever possible, nothing secret in this public repo, one
milestone at a time).

## Run it locally

You need [Bun](https://bun.sh) 1.4 or newer.

```sh
git clone https://github.com/harryfrzz/substrate
cd substrate
bun install
bun run dev
```

Open http://localhost:5173. The web app talks to the control API on port 8080,
which `bun run dev` starts too. Without AWS it shows "No host configured", which
is expected.

To work on the UI against the deployed control API instead of a local one:

```sh
API_URL=https://<public url> bun run --filter @substrate/web dev
```

To drive real VMs from the local UI without making anything public (needs the
AWS setup below):

```sh
bun run dev --host
```

It tunnels to hostd over SSM. When the Clerk keys are in Parameter Store you
sign in as on the real site, and each account sees only its own VMs; without
them, or with `--no-login`, it runs without sign-in and sees only the VMs it
created that way.

The control API reads its settings, such as quotas and sign-in, from environment
variables. [configuration.md](configuration.md) lists them all.

Before pushing:

```sh
bun run typecheck
bun test
```

The control box's tests use an in-memory SQLite by default. To run them against
Postgres as in production, point `TEST_DATABASE_URL` at any Postgres you can
throw away; each test gets a fresh schema:

```sh
docker run -d --name substrate-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres bun test apps/control
```

VM isolation (Phase 2's jailer, network namespaces and egress proxy) is checked
on real Firecracker by `scripts/check-isolation.ts`, on any Linux machine with
KVM, Firecracker and the jailer; its header says how to run it. See
[phase2.md](phase2.md).

## Layout

| Path | What it is |
|---|---|
| `apps/web` | Vite + React + Tailwind web app |
| `apps/control` | Control API (Bun + Hono). Runs on the control box, serves the web app |
| `apps/hostd` | Host daemon (Bun + Hono). Runs on the sandbox host: VM disks, networking, Firecracker |
| `apps/guestd` | Guest agent. Baked into the VM image, answers hostd inside each VM |
| `packages/protocol` | zod schemas shared by everything |
| `infra` | AWS CDK stack (`Substrate`, ap-south-1) |
| `images/host` | Sandbox host setup and hostd install scripts (Ubuntu 24.04) |
| `images/guest` | Guest kernel config and the VM image build (runs on the host) |
| `images/control` | Control box setup script (Amazon Linux 2023) |
| `scripts` | Deploy and admin commands, listed below |

## Working with AWS

These commands need the AWS CLI v2, the
[Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html),
and credentials for the Substrate account.

The owner gives you an access key for the `substrate-dev` IAM user as a
`[substrate]` profile. Add it to `~/.aws/credentials` (create the file if it
doesn't exist), then select it in each shell:

```sh
export AWS_PROFILE=substrate
aws sts get-caller-identity   # should show user/substrate-dev
```

Keep the key private: never commit it, paste it into chats, or share it.

| Command | What it does |
|---|---|
| `bun run secrets` | Creates the hostd token in Parameter Store if it's missing. With `--clerk`, also loads the Clerk keys (run `bunx clerk@latest auth login` first; owner only). With `--ntfy`, creates the topic for alerts and prints it, so you can subscribe in the ntfy app. With `--github-oauth`, asks for the GitHub OAuth app's client ID and secret ([phase2.md](phase2.md)) |
| `bun run deploy:infra` | Deploys the CDK stack (`--require-approval never` skips the prompt) |
| `bun run deploy:control` | Builds the web app and control API, installs them on the control box, waits for the public URL to serve the new version |
| `bun run deploy:host` | Ships hostd, the guest agent and the image scripts to the host as source, runs host setup, builds and restarts hostd. Running VMs keep running |
| `bun run build:windows-image` | Builds the Windows workspace image on a temporary builder (30–45 min). `--keep` keeps a failed builder; `--builder ID` carries on with it |
| `bun run images:build` | Builds the guest kernel and a new VM image on the host (10–20 min). New VMs get it |
| `bun run setup:host` | Runs only `images/host/setup-host.sh` on the host |
| `bun run host status` / `start` / `stop` | Checks, starts or stops the sandbox host |
| `bun run ssm host` / `control` | Opens a shell on either box through SSM |
| `bun run vm list` / `create` / `start` / `stop` / `pause` / `resume` / `auto-pause` / `max-run` / `disk` / `delete` / `exec` / `capacity` | Manages microVMs, e.g. `bun run vm create --name demo --size small --disk 64`, `bun run vm exec demo -- docker ps`, `bun run vm auto-pause demo 30` (or `off`), `bun run vm max-run demo 48` (or `off`), `bun run vm disk demo 64` |
| `bun run logs host` / `control` / `VM` | Recent logs over SSM: hostd, the control API, or a VM's console plus its own journal. `-n LINES` for more or fewer |
| `bun run check:m0` / `check:m1` | Checks a milestone's "Done when" list against the real deployment. `check:m1` creates and deletes a VM |

Each deploy uploads its own release to S3 (`host/releases/…`, `control/releases/…`;
they expire after 14 days). Once it has worked, it also copies what a replacement
box would boot from to the fixed keys the stack's user data reads:
`host/setup-host.sh`, and `control/setup-control.sh` with `control/control.tar.gz`.

**Cost:** the sandbox host (`r8i.4xlarge`) costs about $1.15 an hour while it runs.
Stop it with `bun run host stop` when you're done, until M5 does that
automatically. The control box is cheap and stays on.

The public URL is a CloudFront address. Ask the owner for it; it isn't written
in this repo.

## M6 everyday features

The M6 implementation and deployment/acceptance steps are in [m6.md](m6.md).
It adds UI management, running-state forks, private app previews, GitHub imports,
agent permission modes with disk rollback points, and SSH/VS Code access.
Run `bun run check:m6` only after deploying M6 hostd and rebuilding the guest
image; it creates and cleans up its own test workspaces without restarting the
shared host. Automated M6 AWS checks pass, including public preview and SSH
transport. Account-specific GitHub and interactive VS Code checks are listed in
`m6.md`.
