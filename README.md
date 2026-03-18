<!--
SPDX-FileCopyrightText: 2026 The Linux Foundation

SPDX-License-Identifier: Apache-2.0
-->

# Action Gate

<p align="center">
  <img src="docs/assets/logo.png" alt="Action Gate Logo" width="160" />
</p>

<p align="center">
  <strong>Action Gate</strong> is a GitHub App that gates GitHub Actions workflows and jobs with ownership attestations. Before a workflow-modifying pull request can merge — or a workflow can run — the relevant files and jobs must be vouched for by an authorised person or organisation.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License"/></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js"/></a>
</p>

---

## Why?

GitHub Actions workflows execute arbitrary code with repository secrets. In large organisations it is easy for a workflow to be added or modified without anyone formally acknowledging ownership or reviewing the supply-chain risk. Action Gate adds a lightweight attestation layer:

- **PR gate** — when a pull request modifies a `.github/workflows/*.yml` file, a check run is posted. The check reports which workflows/jobs have attestations and which do not.
- **Runtime gate** — when a workflow is triggered, the same check is applied against the head commit. In `block` mode this causes the check run to fail, which can be enforced as a required status check.

---

## Concepts

| Concept | Description |
| --- | --- |
| **Attestation** | A record that a specific user or org vouches for a workflow file (or individual job within it) |
| **Tier** | `user` — self-reported; `organization` — GitHub org membership is verified server-side |
| **Gate mode** | `audit` (default) — warn only; `block` — fail the check run |
| **Expiry** | Attestations expire after a configurable number of days (default 180, max 730) |

---

## Stack

- **Runtime**: [Cloudflare Workers](https://workers.cloudflare.com/) with `nodejs_compat`
- **Framework**: [Express 5](https://expressjs.com/) + [Probot 14](https://probot.github.io/) (context objects built manually for Workers)
- **Database**: [Prisma 7](https://www.prisma.io/) with `@prisma/adapter-d1` / SQLite (local dev) / [Cloudflare D1](https://developers.cloudflare.com/d1/) (production)
- **Dashboard**: Vanilla HTML/CSS/JS on [Cloudflare Pages](https://pages.cloudflare.com/)
- **CI/CD**: Single GitHub Actions workflow — Lint → Test → Deploy (gated on deployable changes)

---

## Quick start

### 1. Prerequisites

- Node.js ≥ 20
- A GitHub App ([create one](https://github.com/settings/apps/new))
- (Production) A [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers and D1 enabled

### 2. Install dependencies

```bash
npm install
npx prisma generate
bash scripts/patch-prisma-for-workers.sh
```

The patch script rewrites Prisma's generated client for Cloudflare Workers
compatibility (static WASM import instead of runtime compilation).

### 3. Configure

```bash
cp .env.example .env
# Edit .env with your GitHub App credentials and OAuth client
```

Required env vars:

| Variable | Description |
| --- | --- |
| `APP_ID` | GitHub App ID |
| `PRIVATE_KEY` | GitHub App private key (PEM, newlines as `\n`) |
| `WEBHOOK_SECRET` | Webhook secret set in GitHub App settings |
| `DATABASE_URL` | SQLite path for local dev — `file:./prisma/dev.db` |
| `GITHUB_CLIENT_ID` | OAuth App client ID (for dashboard login) |
| `GITHUB_CLIENT_SECRET` | OAuth App client secret |
| `API_BASE_URL` | Public URL of this server (e.g. `https://action-gate.example.com`) |
| `DASHBOARD_URL` | Public URL of the dashboard |
| `CORS_ORIGINS` | Comma-separated allowed origins (falls back to `DASHBOARD_URL`; rejects all if neither is set) |

### 4. Run locally

```bash
# Create the local SQLite database and apply the schema
npx prisma migrate dev

# Tunnel webhooks with smee (https://smee.io)
npx smee-client --url https://smee.io/<your-channel> --target http://localhost:3000/api/github/hooks &

npm run dev
```

The dashboard is served at `http://localhost:3000/dashboard` in development mode.

---

## Deploying to Cloudflare Workers

Action Gate runs on Cloudflare Workers with Node.js compatibility and uses Cloudflare D1 as its production database.

### 1. Create the D1 database

```bash
npm run d1:create
# Copy the database_id from the output into wrangler.toml
```

### 2. Apply migrations to D1

```bash
# Local D1 environment
npm run d1:migrate:local

# Remote (production) D1
npm run d1:migrate:remote
```

### 3. Set secrets

```bash
wrangler secret put APP_ID
wrangler secret put WEBHOOK_SECRET
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put API_BASE_URL
wrangler secret put DASHBOARD_URL
wrangler secret put CORS_ORIGINS
```

**Private key** — pipe the PEM file directly to avoid shell quoting issues:

```bash
cat /path/to/your-app.private-key.pem | wrangler secret put PRIVATE_KEY
```

> **Important:** Do not wrap the value in quotes. `wrangler secret put` reads
> from stdin, and any surrounding `"` characters become part of the stored
> value, which corrupts the PEM format.
>
> The Worker automatically converts PKCS#1 keys (`BEGIN RSA PRIVATE KEY`) to
> PKCS#8 (`BEGIN PRIVATE KEY`) at runtime, since Cloudflare Workers' Web Crypto
> API only supports PKCS#8. No manual key conversion is needed.

### 4. Build and deploy

```bash
npx prisma generate
bash scripts/patch-prisma-for-workers.sh
npm run build
npx wrangler deploy                                          # API worker
npx wrangler pages deploy docs --project-name <project-name> # dashboard
```

> **Note:** Wrangler reads from `dist-worker/`, not `src/`. Always run
> `npm run build` after source changes before manual deploys.

---

## CI/CD

A single GitHub Actions workflow (`.github/workflows/ci.yml`) handles everything:

```text
Lint     ──┐
Test     ──┼── Deploy (main + deployable changes only)
Changes  ──┘
```

- **Lint**: ESLint, actionlint, ShellCheck
- **Test**: TypeScript type-check, Jest (68 tests)
- **Changes**: Detects if any deployable paths were modified (`src/`, `docs/`, `prisma/`, `scripts/`, `package*`, `tsconfig*`, `wrangler.toml`)
- **Deploy**: Runs only on `main` when both lint and test pass *and* deployable files changed. Manual `workflow_dispatch` always deploys.

The deploy step stamps the git SHA into the dashboard footer before the Pages deploy.

---

## GitHub App setup

In your [GitHub App settings](https://github.com/settings/apps):

**Permissions (Repository)**

- `Checks` — Read & Write
- `Contents` — Read-only
- `Pull requests` — Read-only

**Events to subscribe**

- `Pull request`
- `Workflow job`
- `Workflow run`

**Authorization callback URL** (for OAuth dashboard login)

```text
https://your-server.example.com/auth/github/callback
```

---

## REST API

All authenticated endpoints require a `Authorization: Bearer <github_token>` header.

### Attestation endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/attestations` | — | List attestations (filterable by owner, repo, workflow, job, voucher, org) |
| `GET` | `/api/v1/attestations/:id` | — | Get a single attestation |
| `POST` | `/api/v1/attestations` | ✓ | Create an attestation |
| `POST` | `/api/v1/attestations/batch` | ✓ | Create up to 50 attestations in one request |
| `DELETE` | `/api/v1/attestations/:id` | ✓ | Revoke an attestation (owner or repo admin) |

### Repository endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/repositories` | — | List known repositories |
| `GET` | `/api/v1/repositories/:owner/:repo` | — | Get one repository |
| `PUT` | `/api/v1/repositories/:owner/:repo/config` | ✓ admin | Update gate mode / expiry |

### Dashboard endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/summary` | — | Dashboard summary stats |
| `GET` | `/api/v1/runs/recent` | — | Recent workflow runs (filterable by owner, repo) |
| `GET` | `/api/v1/health` | — | Health check |

### OAuth

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/auth/github` | Redirect to GitHub OAuth |
| `GET` | `/auth/github/callback` | OAuth callback — exchanges code for token |

### Example: create a user-tier attestation

```bash
curl -X POST https://your-server.example.com/api/v1/attestations \
  -H "Authorization: Bearer <your-github-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "repository":     "owner/repo",
    "workflow_path":  ".github/workflows/ci.yml",
    "tier":           "user",
    "org_affiliation": "Acme Corp",
    "notes":          "Owned by the platform team",
    "expiry_days":    180
  }'
```

### Example: enable blocking mode for a repo

```bash
curl -X PUT https://your-server.example.com/api/v1/repositories/owner/repo/config \
  -H "Authorization: Bearer <your-github-token>" \
  -H "Content-Type: application/json" \
  -d '{ "mode": "block" }'
```

---

## Dashboard

The `docs/` directory is a self-contained static site deployed to Cloudflare Pages.
Set `window.ACTION_GATE_API_URL` in `docs/config.js` to your API base URL.

Users can log in with their GitHub account via the **Login with GitHub** button
to create attestations directly from the UI, including batch vouching from
the recent workflow runs table.

- **Repositories** (`repositories.html`) — a paginated list of all
  repositories tracked by Action Gate, showing gate mode, active
  attestation counts, and expiry settings. Linked from the dashboard
  stat card.
- **Revoke** — each active attestation in the table has a Revoke button
  (visible when logged in). The server enforces that only the original
  voucher or a repository admin can revoke.
- **My Attestations** (`my-attestations.html`) — a dedicated page showing
  all attestations created by the logged-in user, with status filters
  (all / active / expiring soon), summary stats, and revoke support.

---

## Development

```bash
npm run build          # compile TypeScript + copy WASM to dist-worker/
npm run dev            # tsc + start probot (local dev)
npm run type-check     # type-check without emitting
npm run lint           # run ESLint
npm test               # run Jest tests
npm run prisma:studio  # open Prisma Studio (local SQLite)
npm run d1:create      # create Cloudflare D1 database
npm run d1:migrate:local   # apply migrations to local D1 environment
npm run d1:migrate:remote  # apply migrations to production D1
```

### Pre-commit hooks

This project uses [pre-commit](https://pre-commit.com/) to run checks
automatically on every commit:

```bash
pip install pre-commit   # if not already installed
pre-commit install       # one-time setup
```

Hooks include: trailing-whitespace, end-of-file-fixer, YAML/JSON validation,
ESLint, markdownlint, ShellCheck, REUSE/SPDX compliance, and actionlint. To run all hooks manually:

```bash
pre-commit run --all-files
```

You should also run the full CI check before pushing:

```bash
npm run type-check && npm run lint && npm test
```

---

## License

[Apache 2.0](LICENSE)
