# AGENTS.md — github-action-gate

## Project Overview

GitHub Action Gate — a Cloudflare Workers app that tracks and enforces
workflow/job attestations for GitHub Actions repositories. Includes a
REST API (Express 5 on Workers), webhook handlers (Probot-compatible),
and a static dashboard (Cloudflare Pages).

## Tech Stack

- **Runtime**: Cloudflare Workers with `nodejs_compat`, D1 (SQLite)
- **Language**: TypeScript (strict), ESM throughout (`.js` extensions on imports)
- **Framework**: Express 5, Probot 14 (context objects built manually for Workers)
- **Database**: Prisma 7 with `@prisma/adapter-d1`, patched for static WASM import
- **Dashboard**: Vanilla HTML/CSS/JS on Cloudflare Pages
- **CI/CD**: Single GitHub Actions workflow (`ci.yml`) — Lint → Test → Deploy

## Build & Deploy

```sh
prisma generate                          # generate Prisma client
bash scripts/patch-prisma-for-workers.sh # patch WASM for Workers
npm run build                            # tsc + copy .wasm to dist-worker/
npx wrangler deploy                      # deploy API worker
npx wrangler pages deploy docs           # deploy dashboard
```

The deploy step in CI stamps the git SHA into the dashboard footer via
`sed` before the Pages deploy.

## Conventions

### Code Style

- ESM only — no CommonJS. Use `.js` extensions on all relative imports.
- Prefer simple, focused changes. Don't over-engineer or add speculative abstractions.
- Validate all user input at system boundaries (API routes). Trust internal code.
- Security-first: OWASP-aware, hash secrets in memory, validate redirects,
  escape output in all contexts, cap numeric inputs, add security headers.

### Commits

- **Conventional commits**: `feat:`, `fix:`, `ci:`, `chore:`, `security:`, `docs:`
- Subject line: imperative mood, lowercase after prefix, ~50 chars
- Body: explain *why*, not just *what*. List key changes as bullet points.

### CI Discipline

- **Always run the full CI check locally before committing**:
  ```sh
  npm run type-check && npm run lint && npm test
  ```
  Never skip any step. All three must pass before `git commit`.
- Also run `actionlint` and `shellcheck` for workflow/script changes.

### Workflow

- Work directly on `main` for single-author iteration.
- Use branches + PRs for collaborative or risky changes.
- Deploy is gated: `needs: [lint, test]`, only runs on `main`.
- Pin GitHub Actions by full commit SHA with version comment.

### Testing

- Jest with ESM (`--experimental-vm-modules`)
- Prisma client is mocked in tests via `jest.mock("../db/client.js")`
- 68 tests across 4 suites: routes, attestation service, gate service, workflow-run handler

### Linting

- ESLint (TypeScript config)
- actionlint for GitHub Actions workflows
- ShellCheck for bash scripts in `scripts/`

## Key Files

| Path | Purpose |
|------|---------|
| `src/worker.ts` | Cloudflare Worker entry point (fetch handler) |
| `src/index.ts` | Probot/Express entry point (local dev) |
| `src/api/routes.ts` | All REST API routes + OAuth flow |
| `src/api/middleware.ts` | Bearer token auth with SHA-256 hashed cache |
| `src/services/attestation.ts` | Attestation CRUD + repository management |
| `src/services/gate.ts` | Gate evaluation logic + check run output |
| `src/handlers/` | Webhook handlers (PR, workflow-run, workflow-job) |
| `docs/` | Static dashboard (deployed to Cloudflare Pages) |
| `scripts/patch-prisma-for-workers.sh` | Post-generate Prisma patch for Workers WASM |
| `.github/workflows/ci.yml` | Lint + Test + Deploy pipeline |

## Gotchas

- Cloudflare Workers **forbids all runtime WASM compilation**. Prisma's
  query compiler must be statically imported (see patch script).
- Wrangler reads from `dist-worker/`, not `src/`. Always `npm run build`
  after source changes before manual deploys.
- The `__GIT_SHA__` placeholder in `docs/index.html` is replaced by CI
  at deploy time — don't change it to a real hash in source.
