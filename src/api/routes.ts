import crypto from "crypto";
import { Router, Request, Response } from "express";
import { Octokit } from "@octokit/rest";
import { AttestationTier, GateMode } from "../types";
import {
  createAttestation,
  listAttestations,
  revokeAttestation,
  getRepository,
  updateRepositoryConfig,
} from "../services/attestation";
import { authenticateUser, AuthRequest } from "./middleware";
import { prisma } from "../db/client";

export function createApiRouter(): Router {
  const router = Router();

  // ── Health ─────────────────────────────────────────────────────────────────

  router.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // ── Attestations (public reads) ────────────────────────────────────────────

  /**
   * GET /api/v1/attestations
   * Query params:
   *   owner, repo, workflow, job, voucher, org, active_only, page, per_page
   */
  router.get("/attestations", async (req: Request, res: Response) => {
    try {
      const q = req.query as Record<string, string>;
      const result = await listAttestations({
        owner: q.owner,
        repo: q.repo,
        workflowPath: q.workflow,
        jobName: q.job,
        voucherGithubLogin: q.voucher,
        orgGithubLogin: q.org,
        activeOnly: q.active_only === "true",
        page: q.page ? parseInt(q.page, 10) : 1,
        perPage: q.per_page ? parseInt(q.per_page, 10) : 30,
      });
      res.json(result);
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /** GET /api/v1/attestations/:id */
  router.get("/attestations/:id", async (req: Request, res: Response) => {
    try {
      const attestation = await prisma.attestation.findUnique({
        where: { id: req.params.id },
        include: { repository: { select: { owner: true, name: true } } },
      });
      if (!attestation) {
        res.status(404).json({ error: "Attestation not found" });
        return;
      }
      res.json(attestation);
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Attestations (authenticated writes) ────────────────────────────────────

  /**
   * POST /api/v1/attestations
   *
   * Body:
   * {
   *   "repository":        "owner/repo",          // required
   *   "workflow_path":     ".github/workflows/ci.yml",  // required
   *   "job_name":          "build",               // optional; omit to vouch for whole workflow
   *   "tier":              "user" | "organization",     // default: "user"
   *   "org_github_login":  "my-org",              // required when tier="organization"
   *   "org_affiliation":   "AMD",                 // optional — self-reported label
   *   "notes":             "Reason for vouching", // optional
   *   "expiry_days":       180                    // optional — defaults to repo config
   * }
   */
  router.post(
    "/attestations",
    authenticateUser as unknown as (
      req: Request,
      res: Response,
      next: () => void
    ) => void,
    async (req: AuthRequest, res: Response) => {
      try {
        const {
          repository,
          workflow_path,
          job_name,
          tier,
          org_github_login,
          org_affiliation,
          notes,
          expiry_days,
        } = req.body as Record<string, unknown>;

        if (typeof repository !== "string" || typeof workflow_path !== "string") {
          res
            .status(400)
            .json({ error: "repository (owner/repo) and workflow_path are required" });
          return;
        }

        // Validate workflow path — must be within .github/workflows/
        if (!/^\.github\/workflows\/.+\.ya?ml$/.test(workflow_path)) {
          res.status(400).json({
            error: "workflow_path must match .github/workflows/*.yml",
          });
          return;
        }

        const [repoOwner, repoName] = repository.split("/");
        if (!repoOwner || !repoName) {
          res
            .status(400)
            .json({ error: 'repository must be in "owner/repo" format' });
          return;
        }

        const repoRecord = await getRepository(repoOwner, repoName);
        if (!repoRecord) {
          res.status(404).json({
            error:
              "Repository not found. Install the Action Gate GitHub App on this repository first.",
          });
          return;
        }

        const attestationTier =
          tier === "organization"
            ? AttestationTier.ORGANIZATION
            : AttestationTier.USER;

        if (
          attestationTier === AttestationTier.ORGANIZATION &&
          typeof org_github_login !== "string"
        ) {
          res.status(400).json({
            error:
              "org_github_login is required for organization-tier attestations",
          });
          return;
        }

        // For org-tier attestations, verify the voucher is a member of that org.
        if (
          attestationTier === AttestationTier.ORGANIZATION &&
          typeof org_github_login === "string"
        ) {
          try {
            const userOctokit = new Octokit({ auth: req.token });
            await userOctokit.orgs.checkMembershipForUser({
              org: org_github_login,
              username: req.user!.login,
            });
          } catch {
            res.status(403).json({
              error: `You must be a member of @${org_github_login} to create an organization-tier attestation`,
            });
            return;
          }
        }

        const expiryDays =
          typeof expiry_days === "number" && expiry_days > 0
            ? expiry_days
            : repoRecord.expiryDays;

        const attestation = await createAttestation({
          repositoryId: repoRecord.id,
          workflowPath: workflow_path,
          jobName: typeof job_name === "string" ? job_name : null,
          voucherGithubLogin: req.user!.login,
          voucherGithubId: req.user!.id,
          voucherOrgAffiliation:
            typeof org_affiliation === "string" ? org_affiliation : null,
          tier: attestationTier,
          orgGithubLogin:
            typeof org_github_login === "string" ? org_github_login : null,
          notes: typeof notes === "string" ? notes : null,
          expiryDays,
        });

        res.status(201).json(attestation);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  /**
   * DELETE /api/v1/attestations/:id
   * Revokes an attestation.  Must be the original voucher or a repo admin.
   */
  router.delete(
    "/attestations/:id",
    authenticateUser as unknown as (
      req: Request,
      res: Response,
      next: () => void
    ) => void,
    async (req: AuthRequest, res: Response) => {
      try {
        const attestation = await prisma.attestation.findUnique({
          where: { id: req.params.id },
          include: { repository: true },
        });

        if (!attestation) {
          res.status(404).json({ error: "Attestation not found" });
          return;
        }

        const isOwner = attestation.voucherGithubLogin === req.user!.login;
        let isAdmin = false;

        if (!isOwner) {
          try {
            const userOctokit = new Octokit({ auth: req.token });
            const { data: perm } =
              await userOctokit.repos.getCollaboratorPermissionLevel({
                owner: attestation.repository.owner,
                repo: attestation.repository.name,
                username: req.user!.login,
              });
            isAdmin = ["admin", "maintain"].includes(perm.permission);
          } catch {
            // Could not verify — deny.
          }
        }

        if (!isOwner && !isAdmin) {
          res.status(403).json({
            error:
              "Only the original voucher or a repository admin can revoke this attestation",
          });
          return;
        }

        const revoked = await revokeAttestation(
          req.params.id,
          req.user!.login
        );
        res.json(revoked);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  // ── Repositories (public reads) ────────────────────────────────────────────

  /** GET /api/v1/repositories?page=1&per_page=30 */
  router.get("/repositories", async (req: Request, res: Response) => {
    try {
      const q = req.query as Record<string, string>;
      const page = Math.max(1, parseInt(q.page ?? "1", 10));
      const perPage = Math.min(parseInt(q.per_page ?? "30", 10), 100);
      const skip = (page - 1) * perPage;

      const [repositories, total] = await Promise.all([
        prisma.repository.findMany({
          skip,
          take: perPage,
          orderBy: [{ owner: "asc" }, { name: "asc" }],
          include: {
            _count: {
              select: {
                attestations: {
                  where: { revokedAt: null, expiresAt: { gt: new Date() } },
                },
              },
            },
          },
        }),
        prisma.repository.count(),
      ]);

      res.json({ repositories, total, page, perPage });
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /** GET /api/v1/repositories/:owner/:repo */
  router.get(
    "/repositories/:owner/:repo",
    async (req: Request, res: Response) => {
      try {
        const repo = await prisma.repository.findUnique({
          where: {
            owner_name: { owner: req.params.owner, name: req.params.repo },
          },
          include: {
            _count: {
              select: {
                attestations: {
                  where: { revokedAt: null, expiresAt: { gt: new Date() } },
                },
              },
            },
          },
        });
        if (!repo) {
          res.status(404).json({ error: "Repository not found" });
          return;
        }
        res.json(repo);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  /**
   * PUT /api/v1/repositories/:owner/:repo/config
   * Body: { "mode": "audit"|"block", "expiry_days": 90 }
   * Requires admin permission on the repository.
   */
  router.put(
    "/repositories/:owner/:repo/config",
    authenticateUser as unknown as (
      req: Request,
      res: Response,
      next: () => void
    ) => void,
    async (req: AuthRequest, res: Response) => {
      try {
        const { owner, repo } = req.params;
        const { mode, expiry_days } = req.body as Record<string, unknown>;

        // Verify requester holds admin permission on the repo.
        try {
          const userOctokit = new Octokit({ auth: req.token });
          const { data: perm } =
            await userOctokit.repos.getCollaboratorPermissionLevel({
              owner,
              repo,
              username: req.user!.login,
            });
          if (perm.permission !== "admin") {
            res
              .status(403)
              .json({ error: "Repository admin permission is required" });
            return;
          }
        } catch {
          res.status(403).json({
            error:
              "Could not verify repository admin permissions — ensure your token has repo scope",
          });
          return;
        }

        const updates: { mode?: GateMode; expiryDays?: number } = {};
        if (mode === "audit") updates.mode = GateMode.AUDIT;
        if (mode === "block") updates.mode = GateMode.BLOCK;
        if (typeof expiry_days === "number" && expiry_days > 0) {
          updates.expiryDays = expiry_days;
        }

        const updated = await updateRepositoryConfig(owner, repo, updates);
        res.json(updated);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  );

  // ── Dashboard summary ──────────────────────────────────────────────────────

  /**
   * GET /api/v1/summary
   * High-level stats for the dashboard header cards.
   */
  router.get("/summary", async (_req: Request, res: Response) => {
    try {
      const now = new Date();
      const thirtyDaysLater = new Date(
        now.getTime() + 30 * 24 * 60 * 60 * 1_000
      );

      const [totalRepos, totalAttestations, activeAttestations, expiringSoon] =
        await Promise.all([
          prisma.repository.count(),
          prisma.attestation.count(),
          prisma.attestation.count({
            where: { revokedAt: null, expiresAt: { gt: now } },
          }),
          prisma.attestation.count({
            where: {
              revokedAt: null,
              expiresAt: { gt: now, lte: thirtyDaysLater },
            },
          }),
        ]);

      res.json({
        totalRepos,
        totalAttestations,
        activeAttestations,
        expiringSoon,
      });
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

// ── OAuth ──────────────────────────────────────────────────────────────────────

// Short-lived CSRF nonces for the OAuth code exchange.  state → expiry timestamp.
const oauthStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1_000;
setInterval(() => {
  const now = Date.now();
  for (const [key, exp] of oauthStates) {
    if (exp < now) oauthStates.delete(key);
  }
}, STATE_TTL_MS).unref();

function escText(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Mount at /auth — provides the GitHub OAuth web application flow so that
 * dashboard users can log in with their GitHub identity.
 *
 * Required env vars: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
 * Required GitHub App setting:
 *   Authorization callback URL → {API_BASE_URL}/auth/github/callback
 */
export function createAuthRouter(): Router {
  const router = Router();

  /** GET /auth/github — redirect to GitHub's authorization page */
  router.get("/github", (_req: Request, res: Response) => {
    const clientId = process.env.GITHUB_CLIENT_ID;
    if (!clientId) {
      res
        .type("text")
        .status(503)
        .send("GitHub OAuth is not configured (GITHUB_CLIENT_ID missing).");
      return;
    }

    const state = crypto.randomBytes(16).toString("hex");
    oauthStates.set(state, Date.now() + STATE_TTL_MS);

    const params = new URLSearchParams({
      client_id: clientId,
      scope: "read:org",
      state,
    });
    res.redirect(
      `https://github.com/login/oauth/authorize?${params.toString()}`
    );
  });

  /**
   * GET /auth/github/callback
   * GitHub sends the one-time code here.  We exchange it for a user access
   * token server-side (keeping the client secret off the browser), then
   * redirect to the dashboard with the token in the URL fragment — the
   * fragment is never transmitted to any server.
   */
  router.get("/github/callback", async (req: Request, res: Response) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;

    if (!code || !state) {
      res.type("text").status(400).send("Missing code or state parameter.");
      return;
    }

    const expiry = oauthStates.get(state);
    if (!expiry || expiry < Date.now()) {
      res
        .type("text")
        .status(400)
        .send("OAuth state is invalid or expired — please try logging in again.");
      return;
    }
    oauthStates.delete(state);

    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      res
        .type("text")
        .status(503)
        .send("GitHub OAuth is not fully configured on this server.");
      return;
    }

    try {
      const tokenRes = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
          }),
        }
      );

      const data = (await tokenRes.json()) as Record<string, string>;
      if (data.error || !data.access_token) {
        const msg =
          data.error_description ?? data.error ?? "Token exchange failed";
        res
          .type("text")
          .status(400)
          .send(`GitHub OAuth error: ${escText(msg)}`);
        return;
      }

      // Token goes in the URL fragment — never sent to any server.
      const base = (process.env.DASHBOARD_URL ?? "/dashboard").replace(
        /\/$/,
        ""
      );
      res.redirect(`${base}#token=${encodeURIComponent(data.access_token)}`);
    } catch {
      res
        .type("text")
        .status(500)
        .send("Failed to exchange OAuth code for access token.");
    }
  });

  return router;
}
