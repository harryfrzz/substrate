# Control API configuration

The control API (`apps/control`) reads all of its settings from environment
variables, in [`apps/control/src/config.ts`](../apps/control/src/config.ts).
Everything is optional: with none set, `bun run dev` gives you a local API on
port 8080 with a SQLite database, no sign-in and no sandbox host.

On the control box, `images/control/setup-control.sh` writes these from
Parameter Store. `bun run dev --host` sets the host and Clerk ones for you
([development.md](development.md)). Set the others yourself when you need them,
for example:

```sh
SUBSTRATE_QUOTA_SIZES=small SUBSTRATE_MAX_VMS_PER_USER=1 bun run dev
```

Lists are comma-separated.

## Basics

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Port the API listens on. `bun run dev` sets it to 8080 |
| `AWS_REGION` | `ap-south-1` | Region for AWS calls (KMS, Windows workspaces) |
| `SUBSTRATE_DB` | `.data/control.db` | SQLite file, used when `SUBSTRATE_DATABASE_HOST` is unset |
| `SUBSTRATE_WEB_DIR` | `web` | Built web app to serve, relative to the working directory. Not used by `bun run dev`, where Vite serves the app |
| `SUBSTRATE_PUBLIC_URL` | unset | Public URL of the site. Needed for links in notifications and the GitHub OAuth callback |

## Sandbox host

Without these, VM routes report that no host is configured.

| Variable | Default | What it does |
|---|---|---|
| `SUBSTRATE_HOST_INSTANCE_ID` | unset | EC2 instance ID of the sandbox host |
| `SUBSTRATE_HOSTD_URL` | unset | hostd's URL. Needs `SUBSTRATE_HOSTD_TOKEN` too |
| `SUBSTRATE_HOSTD_TOKEN` | unset | Token for hostd (`/substrate/hostd-token` in Parameter Store) |
| `SUBSTRATE_PREVIEW_ORIGIN` | unset | Origin for app previews. Preview routes are off without it |

## Sign-in

| Variable | Default | What it does |
|---|---|---|
| `CLERK_PUBLISHABLE_KEY` | unset | Clerk sign-in. Needs `CLERK_SECRET_KEY` too |
| `CLERK_SECRET_KEY` | unset | Clerk sign-in. Needs `CLERK_PUBLISHABLE_KEY` too |
| `SUBSTRATE_VMS_WITHOUT_LOGIN` | unset | `1` allows VM routes without Clerk keys. Only for a control API on localhost: these routes hand out shells |
| `SUBSTRATE_ORIGINS` | empty | Frontend origins whose session tokens to accept |
| `SUBSTRATE_ALLOWED_EMAILS` | empty | Only these verified emails may sign in. Empty lets anyone in |
| `SUBSTRATE_ADMINS` | empty | Admins, as Clerk user IDs. They have no quota unless one is set for them |

## Quotas

Everyone gets these limits unless an admin sets their own with
`PUT /api/admin/quotas/:user` ([phase2.md](phase2.md)).

| Variable | Default | What it does |
|---|---|---|
| `SUBSTRATE_MAX_VMS_PER_USER` | `3` | Linux workspaces per user |
| `SUBSTRATE_QUOTA_SIZES` | `small,medium,large` | VM sizes users may create |
| `SUBSTRATE_QUOTA_MAX_DISK_GIB` | `128` | Largest disk for one VM, in GiB |
| `SUBSTRATE_QUOTA_MAX_TOTAL_DISK_GIB` | `256` | Total disk across a user's VMs, in GiB |
| `SUBSTRATE_QUOTA_RUNNING_HOURS` | `200` | Running hours per user |
| `SUBSTRATE_QUOTA_EGRESS` | `open` | `allowlist` limits VM network egress; anything else means `open` |

## Postgres

Setting `SUBSTRATE_DATABASE_HOST` switches from SQLite to Postgres on RDS
([database-migration.md](database-migration.md)). The API signs in with IAM,
never a password.

| Variable | Default | What it does |
|---|---|---|
| `SUBSTRATE_DATABASE_HOST` | unset | Postgres hostname |
| `SUBSTRATE_DATABASE_PORT` | `5432` | Postgres port |
| `SUBSTRATE_DATABASE_NAME` | `substrate` | Database name |
| `SUBSTRATE_DATABASE_USER` | `substrate_app` | User to sign in as |
| `SUBSTRATE_DATABASE_MASTER_SECRET` | unset | ARN of the RDS master secret, used only to create that user once |
| `SUBSTRATE_DATABASE_CA` | unset | CA bundle file for TLS |

Tests use `TEST_DATABASE_URL` instead ([development.md](development.md)).

## Integrations

| Variable | Default | What it does |
|---|---|---|
| `SUBSTRATE_KMS_KEY` | unset | KMS key that encrypts users' agent keys and GitHub tokens. Both features are off without it |
| `SUBSTRATE_GITHUB_CLIENT_ID` | unset | GitHub OAuth app for "Connect with GitHub". Needs the secret and `SUBSTRATE_PUBLIC_URL` |
| `SUBSTRATE_GITHUB_CLIENT_SECRET` | unset | Secret for that app |
| `SUBSTRATE_TELEGRAM_BOT_TOKEN` | unset | Telegram notifications. Needs all three Telegram variables ([task-notifications.md](task-notifications.md)) |
| `SUBSTRATE_TELEGRAM_BOT_USERNAME` | unset | The bot's username |
| `SUBSTRATE_TELEGRAM_WEBHOOK_SECRET` | unset | Secret for the bot's webhook |

## Windows workspaces

Setting `SUBSTRATE_WINDOWS_SUBNET` turns on Windows workspaces (M9, [m9.md](m9.md)).

| Variable | Default | What it does |
|---|---|---|
| `SUBSTRATE_WINDOWS_SUBNET` | unset | Subnet for Windows instances |
| `SUBSTRATE_WINDOWS_INSTANCE_TYPE` | `m8i.4xlarge` | EC2 instance type |
| `SUBSTRATE_MAX_WINDOWS_RUNNING` | `1` | Windows workspaces running at once, across all users |
| `SUBSTRATE_MAX_WINDOWS_PER_USER` | `2` | Windows workspaces per user |
| `SUBSTRATE_WINDOWS_IDLE_STOP_MINUTES` | `30` | Idle minutes before a Windows workspace stops |
