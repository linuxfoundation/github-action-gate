# 🔒 Action Gate

**Action Gate** is a GitHub App that gates GitHub Actions workflows and jobs with ownership attestations. Before a workflow-modifying pull request can merge — or a workflow can run — the relevant files and jobs must be vouched for by an authorised person or organisation.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

---

## Why?

GitHub Actions workflows execute arbitrary code with repository secrets. In large organisations it is easy for a workflow to be added or modified without anyone formally acknowledging ownership or reviewing the supply-chain risk. Action Gate adds a lightweight attestation layer:

- **PR gate** — when a pull request modifies a `.github/workflows/*.yml` file, a check run is posted. The check reports which workflows/jobs have attestations and which do not.
- **Runtime gate** — when a workflow is triggered, the same check is applied against the head commit. In `block` mode this causes the check run to fail, which can be enforced as a required status check.

---

## Concepts

| Concept | Description |
|---|---|
| **Attestation** | A record that a specific user or org vouches for a workflow file (or individual job within it) |
| **Tier** | `user` — self-reported; `organization` — GitHub org membership is verified server-side |
| **Gate mode** | `audit` (default) — warn only; `block` — fail the check run |
| **Expiry** | Attestations expire after a configurable number of days (default 180) |

---

## Stack

- **Runtime**: [Probot](https://probot.github.io/) v13 (TypeScript)
- **Database**: SQLite (local dev) via [Prisma](https://www.prisma.io/) v5 / [Cloudflare D1](https://developers.cloudflare.com/d1/) (production)
- **Deployment**: [Cloudflare Workers](https://workers.cloudflare.com/) with Node.js compatibility
- **API**: Express REST API mounted on the Probot router
- **Dashboard**: Static GitHub Pages site (`docs/`) with GitHub OAuth login

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
```

### 3. Configure

```bash
cp .env.example .env
# Edit .env with your GitHub App credentials and OAuth client
```

Required env vars:

| Variable | Description |
|---|---|
| `APP_ID` | GitHub App ID |
| `PRIVATE_KEY` | GitHub App private key (PEM, newlines as `\n`) |
| `WEBHOOK_SECRET` | Webhook secret set in GitHub App settings |
| `DATABASE_URL` | SQLite path for local dev — `file:./prisma/dev.db` |
| `GITHUB_CLIENT_ID` | OAuth App client ID (for dashboard login) |
| `GITHUB_CLIENT_SECRET` | OAuth App client secret |
| `API_BASE_URL` | Public URL of this server (e.g. `https://action-gate.example.com`) |
| `DASHBOARD_URL` | Public URL of the dashboard (e.g. `https://your-org.github.io/github-action-gate`) |

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
wrangler secret put PRIVATE_KEY
wrangler secret put WEBHOOK_SECRET
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put API_BASE_URL
wrangler secret put DASHBOARD_URL
```

### 4. Deploy

```bash
npm run build
wrangler deploy
```

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
```
https://your-server.example.com/auth/github/callback
```

---

## REST API

All authenticated endpoints require a `Authorization: Bearer <github_token>` header.

### Attestation endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/attestations` | — | List attestations (filterable) |
| `GET` | `/api/v1/attestations/:id` | — | Get a single attestation |
| `POST` | `/api/v1/attestations` | ✓ | Create an attestation |
| `DELETE` | `/api/v1/attestations/:id` | ✓ | Revoke an attestation |

### Repository endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/repositories` | — | List known repositories |
| `GET` | `/api/v1/repositories/:owner/:repo` | — | Get one repository |
| `PUT` | `/api/v1/repositories/:owner/:repo/config` | ✓ admin | Update gate mode / expiry |
| `GET` | `/api/v1/summary` | — | Dashboard summary stats |

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

The `docs/` directory is a self-contained static site that connects to the API. Host it on GitHub Pages (or any static host) and set `window.ACTION_GATE_API_URL` in `docs/index.html` to your API base URL.

Users can log in with their GitHub account via the **Login with GitHub** button to create attestations directly from the UI.

---

## Development

```bash
npm run build          # compile TypeScript
npm run dev            # tsc + start probot
npm run type-check     # type-check without emitting
npm run prisma:studio  # open Prisma Studio (local SQLite)
npm run d1:create      # create Cloudflare D1 database
npm run d1:migrate:local   # apply migrations to local D1 environment
npm run d1:migrate:remote  # apply migrations to production D1
```

---

## License

[Apache 2.0](LICENSE)
