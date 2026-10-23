# Substrate plan

Substrate runs persistent sandboxes for long-running coding agents (Claude Code,
Codex, OpenCode, Antigravity CLI, custom agents). Each Linux workspace is a
Firecracker microVM on AWS. You use them from a laptop, tablet or phone.

| Phase | Who uses it | Goal |
|---|---|---|
| 1. Personal | Me, plus a friend helping build it | Everything I need day to day, on one host, as cheaply as possible |
| 2. Private beta | Me plus a few invited people | Safe to share: real login, isolation between users, billing |
| 3. Public launch | Anyone | Sign-up, many hosts, scaling on demand (draft) |

Finish each phase before starting the next. Phases 2 and 3 are outlines; they get
expanded into milestones when their turn comes.

## Ground rules (all phases)
- Work in `~/substrate` (GitHub `harryfrzz/substrate`, branch `main`).
- Build from scratch. Don't copy or reuse code from the older kestrel attempt, and
  never push from its folder.
- Use TypeScript wherever possible. Only Firecracker itself, the guest kernel config,
  image build scripts and host setup scripts are not TS.
- The repo is public: never commit secrets, tokens, account IDs or IPs.
- You can't run `cdk deploy` (the safety check blocks it). When infra changes, stop
  and ask me to run `! cd ~/substrate/infra && bunx cdk deploy`.
- Check each milestone on real AWS against its "Done when" before starting the
  next. Commit each milestone separately and push once it passes.
- Leave alone any AWS resources the `Substrate` stack didn't create, including the
  shared `CDKToolkit` stack and its bucket.
- Report what you checked and how, with numbers such as boot and resume times.
- When something needs me (deploys, MFA, tokens), stop and give me the exact
  command to run.

---

# Phase 1: Personal

Only me and a friend helping build it use it. Nothing here is production.

## AWS
- Region `ap-south-1`. CDK is already bootstrapped there.
- Use an admin IAM user with MFA for the CLI, not the root account.
- The host costs about $1.15/h. For the hackathon, keep the single host warm,
  including while workspace VMs are paused, and stop it manually when the
  hackathon is over. M5's automatic shutdown is deferred.
- One CDK stack named `Substrate`:
  - VPC with one public subnet and no NAT gateway. Nothing is reachable from the
    internet except through CloudFront; all admin access goes through SSM.
  - Control box: `t4g.small`, Amazon Linux 2023 arm64, always on, with an Elastic
    IP. Runs the control API and the web UI.
  - CloudFront in front of the control box: the public HTTPS URL
    (`https://<id>.cloudfront.net`), with no domain needed. Caching is off.
  - Sandbox host: `r8i.4xlarge` (memory-optimized, 16 vCPU / 128 GiB), Ubuntu 24.04
    x86_64, with nested virtualization turned on through the launch template
    (`CpuOptions.NestedVirtualization: enabled`). 30 GB gp3 root disk, plus a
    separate 50 GB gp3 data disk (`RemovalPolicy.RETAIN`) that holds a ZFS pool.
  - Security groups: CloudFront (its AWS-managed prefix list) can reach the
    control API's port, and the control box can reach hostd's port on the host.
    Nothing else is open.
  - SSM Parameter Store SecureStrings for the control↔host token, and later the
    GitHub token. Create them with a script so they never land in shell history.
  - S3 bucket for build artifacts (kernel, rootfs, binaries).
  - A monthly AWS Budget with an email alert. The account's existing budget
    covers this, so the stack doesn't create one.

## Stack
| Part | Choice |
|---|---|
| Monorepo | Bun workspaces (Bun 1.4.4), TypeScript strict |
| `apps/web` | Vite 8 + React 19 + Tailwind CSS 4 + `@xterm/xterm` 6. Mobile-first: on-screen key bar (Esc, Ctrl, Tab, arrows), installable as a PWA |
| `apps/control` | Bun + Hono 4 on the control box. Serves the web build and a REST + WebSocket API, relays terminals and preview URLs to hostd, and starts/stops the host (M5). State in SQLite (`bun:sqlite`) |
| `apps/hostd` | Bun + TS on the sandbox host. Talks to Firecracker's HTTP API over its Unix socket using a typed client generated from Firecracker's OpenAPI spec. Handles ZFS, TAP networking, snapshots and capacity checks |
| `apps/guestd` | Bun + TS, built with `bun build --compile` into one binary inside the rootfs and run by systemd. Runs terminals with `Bun.spawn({ terminal })`, keeps sessions and their scrollback, reports agent activity |
| `packages/protocol` | zod schemas and types shared by all of the above |
| `infra` | AWS CDK (`aws-cdk-lib` 2.273) in TS |
| Sign-in | Clerk: `@clerk/react` in the web app, `@clerk/backend` in the control API (M4) |
| `images` | Host setup script, guest kernel config and build script, rootfs build script |

## VM design
- Firecracker v1.17.0. Add the jailer in Phase 2.
- Sizes: the default is 6 vCPU / 16 GB, with smaller presets of 4 vCPU / 8 GB and
  2 vCPU / 4 GB. With hyperthreading on, Firecracker only accepts 1 or an even
  number of vCPUs.
- Disk: 32 GiB by default, chosen at creation (`--disk`), from the image's size
  (8 GiB) up to the host's storage pool. Disks are thin, so they only use what
  the VM writes, but every VM shares the one pool.
- Capacity: CPU can be overcommitted but memory can't. hostd keeps about 4 GB for
  the host and refuses a VM that doesn't fit, which leaves room for about 7 default
  VMs (more once M8 lands).
- Guest: Ubuntu 24.04 rootfs and a custom kernel with everything Docker needs
  (cgroups v2, overlayfs, netfilter/nftables, bridge, veth). Preinstalled: Docker,
  git, gh, Node, Bun, Python, tmux, Claude Code, Codex, OpenCode, Antigravity CLI
  (`agy`).
- Firecracker only runs Linux. Windows and macOS workspaces are separate EC2
  instances (M9, M10), shown in the same UI.
- Disks: the base rootfs is a ZFS zvol snapshot, and each VM gets an instant
  copy-on-write clone of it. Turn compression on (lz4 or zstd) so memory snapshots
  of mostly empty RAM stay small.
- Stopping a VM, or the whole host, shuts the guest down cleanly first: each
  VM's systemd unit asks the guest agent to reboot, which (with `reboot=k`)
  ends Firecracker. Guests flush writes within ~5 s, so even a host crash
  loses at most a few seconds of writes. Firecracker's SendCtrlAltDel isn't
  used because the 6.18 guest kernel doesn't detect its emulated i8042.
- Network: one TAP device per VM on its own /30, with NAT out through nftables.
  The guest gets its IP from kernel boot arguments.
- Host ↔ guest: TCP over the VM's private link, because Bun can't open vsock
  sockets. Each VM gets a token through Firecracker's metadata service (MMDS), and
  guestd only listens on the private link.
- hostd is the source of truth for VMs (each VM's ZFS dataset plus a `vm.json`
  in it), so nothing is lost when it restarts. VMs run in their own systemd
  units, so restarting hostd never stops them.
- M1 boots VMs from Firecracker's `--config-file`, so no generated API client
  yet; it arrives when pause/resume (M3) needs the API. Until M2 gives the
  control box a reason to call hostd, hostd's token lives in a root-only file
  on the host; M2 moves it to Parameter Store.
- Start modes: blank (an agent starts right away in an empty workspace), terminal
  only, and from GitHub (M6).

## Access
- The web UI is public at the CloudFront URL, so it works from a laptop, tablet
  or phone. The URL isn't written in this repo; share it directly.
- Sign-in is Clerk (M4). Without Clerk keys on the control box, VM routes stay
  off on the public URL; `bun run dev --host` works with VMs locally meanwhile.
- Preview URLs (M6) use a second CloudFront distribution, separate from the
  control UI, with `/p/<vm-id>/<port>/` paths and short-lived owner access.
  No custom domain is needed; apps configure that base path.

## Milestones
**M0 AWS setup:** the CDK stack, host setup script, ZFS pool, budget, and the
public URL serving a status page (control box and host state).
Done when: `cdk deploy` succeeds, both boxes are reachable over SSM, the host has
`/dev/kvm`, the ZFS pool is on the data disk, the budget alert exists, and the
public URL serves the status page. `bun run check:m0` checks all of it.

**M1 microVMs:** hostd can create, list and delete VMs; kernel and rootfs builds
work.
Done when: a default VM boots in about 4 s or less, has internet,
`docker run hello-world` works, and every agent CLI prints its version.

**M2 Terminals:** a login on the public URL, then a web UI that lists VMs,
creates them (size and start mode), and opens browser terminals.
Done when: after closing the tab and reopening it, including from another device,
the same session is there with its scrollback, and the process kept running.

**M3 Pause/resume:** pause saves the whole VM (memory and disk) to ZFS.
Done when: resume takes 0.5 s or less (target 0.2 s), and a paused VM survives the
host being stopped and started.

**M4 Auto-pause:** guestd notices when an agent stops, using Claude Code
Stop/Notification hooks, Codex `notify`, an OpenCode plugin, and an idle check
(no terminal output and low CPU). After N idle minutes (10 by default, set per
VM) the VM pauses itself and alerts me through ntfy, and typing into its terminal
wakes it. hostd polls each guest and keeps the ntfy topic, so nothing in a VM
can read or forge alerts. See `docs/m4.md`.
Done when: an agent finishing a task sends the alert and pauses the VM, and typing
resumes it.

M4 also adds **sign-in with Clerk**:
- Anyone can create an account and sign in (my choice for now). Setting
  `SUBSTRATE_ALLOWED_EMAILS` on the control box limits it to verified emails.
- Each VM belongs to the user who created it; others get a 404 for it. Each
  user may have up to 3 VMs (`SUBSTRATE_MAX_VMS_PER_USER`). Ownership is in
  SQLite on the control box; hostd knows nothing about users.
- The web app sends the Clerk session token with every call. Terminals use
  one-time tickets instead, because browsers can't add headers to WebSockets.
- Keys live in Parameter Store (`bun run secrets --clerk`); the control API
  hands the web app the publishable key at `/api/config`.
- It uses Clerk's development instance: a production instance needs a custom
  domain, which comes in Phase 2.
Done when: signing in on the public URL shows only your own VMs and opens their
terminals, signed-out requests can't reach any VM route, and a second account
can't see or open the first account's VMs.

**M5 Host auto-stop — deferred for the hackathon:** keep one EC2 sandbox host
running throughout the hackathon to avoid host cold starts. Do not add the idle
shutdown or maximum-uptime shutdown guard for this period. M4's workspace
auto-pause can still save VM resources while the host stays warm. Stop the host
manually when the hackathon is over. This is an intentional deferral, not an
implemented milestone, and it does not block M6.

Future design, to revisit after the hackathon: once every VM has been paused or stopped for about 5
minutes, the control box stops the host. Clicking Resume or opening a paused VM's
terminal starts the host first; that takes about 60 s, and the UI shows "waking
up". A maximum-uptime cost guard (e.g. 12 h) stops the host no matter what.
Future acceptance: with all VMs idle, the host stops within about 5 minutes, and opening a
terminal gets me back in under 90 s.

**M6 Everyday features:**
- Create, delete and resize VMs from the UI, either one per project or one per
  task.
- Fork: copy a VM, including its running state, to try two approaches in
  parallel.
- Preview URLs: open a VM's dev server in the browser. Visiting the link wakes a
  paused VM.
- GitHub: a fine-grained token limited to the repos I pick, set up with `gh` inside
  the VM. Clone repos from the UI, push branches and open PRs. This is also the
  "from GitHub" start mode.
- Agent mode per session, either full-auto or ask-for-permission. Take a ZFS
  checkpoint before each run so I can roll back.
- VS Code Remote / SSH into a VM through the control box, with no open ports.

**M7 Hardening for 24-hour runs:**
- A maximum run time per VM (24 h by default, set per VM), so a stuck agent
  can't run forever: the VM pauses with an alert.
- Daily EBS snapshots of the data disk (Data Lifecycle Manager), kept a week.
- Recovery: if a paused VM can't be restored, boot it fresh from the disk saved
  with it, reopening its sessions with `claude --continue` (and Codex's and
  OpenCode's equivalents). VMs that go down without being stopped, including in
  a host crash, come back the same way.
- A disk size limit per VM that can be raised on request, even while it runs.
- Logs (`bun run logs`) and health checks: alerts when the storage pool fills up
  or turns unhealthy, or a guest stops answering.
- Dropped: diff snapshots for 2–3 s pauses. Pauses stay full (7–42 s).
See `docs/m7.md`.
Done when: a VM crash and a save that can't be restored both bring the VM back
with its sessions and an alert, a running VM's disk grows, and the data disk has
daily snapshots.

**M8 Elastic memory:** a balloon device lets VMs start at 4 GB, grow to their limit
(16 GB by default), and hand memory back when idle.
Done when: three idle default VMs together use under about 16 GB of host RAM.

**M9 Windows workspaces:** a Windows workspace is its own EC2 instance, not a
microVM.
- Windows Server 2025 with the license included, on `m8i.xlarge` (4 vCPU / 16 GB,
  about $0.41/h in ap-south-1). Windows 11 can't be used this way: AWS only allows
  it with your own license on dedicated hardware.
- Created and started on demand from the same UI. It takes a few minutes to boot,
  and the UI shows progress.
- Remote desktop through Amazon DCV (free on EC2) in the browser, so it works on
  phones and tablets. Reached through the control box like everything else, with
  no open ports.
- Comes with Git, Node, Claude Code and Codex. WSL2 can work too, since `m8i`
  supports nested virtualization.
- Disk on EBS. The same idle rules as M4 apply, but the instance is stopped rather
  than paused.
Done when: I can create a Windows workspace from the UI, open its desktop in the
browser on my phone, run Claude Code in PowerShell, and it stops itself when idle.

**M10 macOS workspaces (optional):** a macOS workspace runs on an EC2 Mac
dedicated host.
- AWS bills Mac hosts in 24-hour minimums, so every start costs at least a full
  day. The UI must warn about this before allocating one.
- ap-south-1 only offers `mac1.metal` (Intel Mac mini). The nearest Apple Silicon
  is `mac2.metal` (M1) in ap-southeast-1 (Singapore).
- Apple's license allows at most 2 macOS VMs per Mac. For personal use, use the
  host's own macOS directly.
- Remote desktop through Apple Screen Sharing (VNC), shown in the browser with
  noVNC and tunneled through the control box.
- Release the host when done (after the 24-hour minimum).
Done when: I can allocate a Mac from the UI after a cost warning, open its desktop
in the browser, run an agent, and release it.

See `docs/m10.md`. Built: macOS VMs (two to a Mac, with tart), the cost warning,
terminals, and releasing an empty Mac after its 24 hours. Next: the desktop.

---

# Phase 2: Private beta

Before anyone else uses Substrate. Phase 1 must be finished first.

**Access**
- A custom domain with HTTPS, so sign-in can move to Clerk's production
  instance. (Clerk sign-in, per-user VMs and terminal tickets arrive in M4.)

**Data**
- Postgres (Amazon RDS, small instance) for users, VMs, sessions, events and
  billing, replacing SQLite.

**Isolation between users**
- The Firecracker jailer for every VM.
- A separate network namespace per VM.
- An outbound proxy with an allowlist.
- Per-user quotas (VM count, sizes, disk, running hours).

**Secrets**
- All tokens in Parameter Store, rotated on a schedule.
- Users' own agent API keys (Anthropic, OpenAI) encrypted with KMS and sent into
  their VMs only.

**Billing**
- Monthly subscription plans through Stripe.
- Usage measured from active VM time, which M4's events already record.

**Notifications**
- A channel chosen per user: ntfy, Telegram or email (Amazon SES).

Done when: an invited person can sign in with GitHub, create and use their own VMs,
can't see or reach mine, stays inside their quota, and is billed for active VM
time.

---

# Phase 3: Public launch (draft)

Open sign-up and many hosts. This is a draft from early architecture
discussions; it gets reviewed and turned into milestones after Phase 2.

| Need | AWS service / choice |
|---|---|
| Frontend | S3 + CloudFront |
| DNS and TLS | Route 53 + ACM, including a wildcard cert for `*.preview.<domain>` |
| API and gateway | Hono on Node/Bun in ECS Fargate behind an ALB. The terminal/preview gateway is split into its own service when traffic grows |
| Database | Aurora Serverless v2 (Postgres), migrated from RDS |
| Background jobs and schedules | SQS + EventBridge Scheduler |
| Host fleet | EC2 Auto Scaling group of nested-virtualization hosts (`.metal` later for density), with warm pools because hosts boot slowly. A scheduler places VMs across hosts, and hosts connect outbound to the control plane |
| Snapshots | Paused VMs are stored in S3 so they can wake on any host. Keep the fleet on one instance family, because Firecracker snapshots only restore on the same CPU type |
| Secrets | Secrets Manager + KMS |
| Logs and metrics | CloudWatch + the AWS Distro for OpenTelemetry |
| Email | Amazon SES |
| Login | Clerk (from M4), on its production instance with the custom domain |
| GitHub access | A GitHub App with short-lived per-repo tokens, replacing personal tokens |
| Billing | Stripe, charged per second of active VM time |

Also planned for this phase:
- Windows and macOS as paid tiers.
- A mobile chat view built on the agents' JSON output
  (`claude -p --output-format stream-json`, `codex exec --json`), in addition to
  the terminal.
- Avoid API Gateway WebSockets for terminals: connections are capped at 2 hours,
  drop after 10 idle minutes, and are billed per message.

Done when: a new user can sign up and get a running VM within seconds, and the
host fleet grows and shrinks on its own.

---

## How to start
Scaffold the monorepo, then start Phase 1 at M0.
