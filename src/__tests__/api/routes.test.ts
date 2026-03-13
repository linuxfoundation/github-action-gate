import request from "supertest";
import express from "express";

// @octokit/rest ships as ESM; mock it before importing anything that requires it.
// The mock Octokit needs a .plugin() method that returns itself, since
// src/api/octokit.ts calls Octokit.plugin(retry) to create RetryOctokit.
const MockOctokit = jest.fn().mockImplementation(() => ({
  orgs: {
    checkMembershipForUser: jest.fn().mockResolvedValue({}),
  },
  repos: {
    getCollaboratorPermissionLevel: jest.fn().mockResolvedValue({ data: { permission: "admin" } }),
  },
  users: {
    getAuthenticated: jest.fn().mockResolvedValue({
      data: { id: 1, login: "alice", name: "Alice", email: null },
    }),
  },
}));
// .plugin() returns the same constructor so RetryOctokit === MockOctokit
(MockOctokit as any).plugin = jest.fn().mockReturnValue(MockOctokit);

jest.mock("@octokit/rest", () => ({ Octokit: MockOctokit }));
jest.mock("@octokit/plugin-retry", () => ({ retry: jest.fn() }));

import { createApiRouter } from "../../api/routes";

// ── Mock service layer ─────────────────────────────────────────────────────────
jest.mock("../../services/attestation");
jest.mock("../../api/middleware");

// ── Mock Prisma ────────────────────────────────────────────────────────────────
jest.mock("../../db/client", () => ({
  prisma: {
    repository: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    attestation: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    workflowRun: {
      findMany: jest.fn(),
    },
  },
}));

import { prisma } from "../../db/client";
import {
  listAttestations,
  getRepository,
  createAttestation,
  revokeAttestation,
} from "../../services/attestation";
import { authenticateUser } from "../../api/middleware";

// Typed mocks
const mockListAttestations = listAttestations as jest.MockedFunction<typeof listAttestations>;
const mockGetRepository = getRepository as jest.MockedFunction<typeof getRepository>;
const mockCreateAttestation = createAttestation as jest.MockedFunction<typeof createAttestation>;
const _mockRevokeAttestation = revokeAttestation as jest.MockedFunction<typeof revokeAttestation>;
const mockPrisma = prisma as jest.Mocked<typeof prisma>;

// Make authenticateUser a pass-through by default (attaches a test user)
const mockAuth = authenticateUser as jest.MockedFunction<typeof authenticateUser>;

// Build the Express app for tests
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createApiRouter());
  return app;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const FUTURE = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    id: "repo-1",
    owner: "acme",
    name: "app",
    githubId: 1,
    installationId: 10,
    mode: "AUDIT",
    expiryDays: 180,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeAttestation(overrides: Record<string, unknown> = {}) {
  return {
    id: "att-1",
    repositoryId: "repo-1",
    workflowPath: ".github/workflows/ci.yml",
    jobName: null,
    voucherGithubLogin: "alice",
    voucherGithubId: 1,
    voucherOrgAffiliation: null,
    tier: "USER",
    orgGithubLogin: null,
    notes: null,
    expiresAt: FUTURE,
    revokedAt: null,
    revokedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    repository: { owner: "acme", name: "app" },
    ...overrides,
  };
}

// ── GET /health ────────────────────────────────────────────────────────────────

describe("GET /api/v1/health", () => {
  it("returns 200 with status ok", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.timestamp).toBe("string");
  });
});

// ── GET /api/v1/attestations ───────────────────────────────────────────────────

describe("GET /api/v1/attestations", () => {
  it("returns attestations list from service", async () => {
    const att = makeAttestation();
    mockListAttestations.mockResolvedValue({
      attestations: [att] as any,
      total: 1,
      page: 1,
      perPage: 30,
    });

    const app = buildApp();
    const res = await request(app).get("/api/v1/attestations");

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.attestations).toHaveLength(1);
  });

  it("passes query parameters to listAttestations", async () => {
    mockListAttestations.mockResolvedValue({
      attestations: [],
      total: 0,
      page: 1,
      perPage: 30,
    });

    const app = buildApp();
    await request(app).get(
      "/api/v1/attestations?owner=acme&repo=app&active_only=true&page=2&per_page=10"
    );

    expect(mockListAttestations).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "app",
        activeOnly: true,
        page: 2,
        perPage: 10,
      })
    );
  });
});

// ── GET /api/v1/attestations/:id ──────────────────────────────────────────────

describe("GET /api/v1/attestations/:id", () => {
  it("returns 200 with the attestation when found", async () => {
    const att = makeAttestation();
    (mockPrisma.attestation.findUnique as jest.Mock).mockResolvedValue(att);

    const app = buildApp();
    const res = await request(app).get("/api/v1/attestations/att-1");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("att-1");
  });

  it("returns 404 when attestation is not found", async () => {
    (mockPrisma.attestation.findUnique as jest.Mock).mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app).get("/api/v1/attestations/missing");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ── POST /api/v1/attestations ─────────────────────────────────────────────────

describe("POST /api/v1/attestations", () => {
  beforeEach(() => {
    // Make auth middleware pass and inject a test user
    mockAuth.mockImplementation(async (req: any, _res, next) => {
      req.user = { id: 1, login: "alice", name: "Alice", email: null };
      req.token = "test-token";
      next();
    });
  });

  it("returns 400 when repository or workflow_path is missing", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/attestations")
      .set("Authorization", "Bearer test-token")
      .send({ repository: "acme/app" }); // missing workflow_path

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workflow_path/i);
  });

  it("returns 400 when workflow_path does not match the required pattern", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/attestations")
      .set("Authorization", "Bearer test-token")
      .send({
        repository: "acme/app",
        workflow_path: "scripts/deploy.sh", // invalid
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/\.github\/workflows/i);
  });

  it("returns 400 when repository is not in owner/repo format", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/attestations")
      .set("Authorization", "Bearer test-token")
      .send({
        repository: "bad-format",
        workflow_path: ".github/workflows/ci.yml",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owner\/repo/i);
  });

  it("returns 404 when repository is not installed", async () => {
    mockGetRepository.mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/attestations")
      .set("Authorization", "Bearer test-token")
      .send({
        repository: "acme/app",
        workflow_path: ".github/workflows/ci.yml",
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 400 when tier=organization but org_github_login is missing", async () => {
    mockGetRepository.mockResolvedValue(makeRepo() as any);
    (mockPrisma.attestation.findFirst as jest.Mock).mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/attestations")
      .set("Authorization", "Bearer test-token")
      .send({
        repository: "acme/app",
        workflow_path: ".github/workflows/ci.yml",
        tier: "organization",
        // no org_github_login
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/org_github_login/i);
  });

  it("returns 409 when an active attestation already exists", async () => {
    mockGetRepository.mockResolvedValue(makeRepo() as any);
    (mockPrisma.attestation.findFirst as jest.Mock).mockResolvedValue(makeAttestation());

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/attestations")
      .set("Authorization", "Bearer test-token")
      .send({
        repository: "acme/app",
        workflow_path: ".github/workflows/ci.yml",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
    expect(res.body.error).toContain("att-1");
  });

  it("returns 201 and creates the attestation on success", async () => {
    mockGetRepository.mockResolvedValue(makeRepo() as any);
    (mockPrisma.attestation.findFirst as jest.Mock).mockResolvedValue(null);
    mockCreateAttestation.mockResolvedValue(makeAttestation() as any);

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/attestations")
      .set("Authorization", "Bearer test-token")
      .send({
        repository: "acme/app",
        workflow_path: ".github/workflows/ci.yml",
        notes: "LGTM",
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("att-1");
    expect(mockCreateAttestation).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowPath: ".github/workflows/ci.yml",
        voucherGithubLogin: "alice",
      })
    );
  });
});

// ── GET /api/v1/summary ───────────────────────────────────────────────────────

describe("GET /api/v1/summary", () => {
  it("returns aggregated counts", async () => {
    (mockPrisma.repository.count as jest.Mock).mockResolvedValue(5);
    (mockPrisma.attestation.count as jest.Mock)
      .mockResolvedValueOnce(20) // totalAttestations
      .mockResolvedValueOnce(15) // activeAttestations
      .mockResolvedValueOnce(3); // expiringSoon

    const app = buildApp();
    const res = await request(app).get("/api/v1/summary");

    expect(res.status).toBe(200);
    expect(res.body.totalRepos).toBe(5);
    expect(res.body.totalAttestations).toBe(20);
    expect(res.body.activeAttestations).toBe(15);
    expect(res.body.expiringSoon).toBe(3);
  });
});

// ── GET /api/v1/runs/recent ────────────────────────────────────────────────────

describe("GET /api/v1/runs/recent", () => {
  const RUN = {
    id: "run-1",
    repositoryId: "repo-1",
    runId: "123",
    workflowPath: ".github/workflows/ci.yml",
    headBranch: "main",
    headSha: "abc123",
    event: "push",
    status: "completed",
    conclusion: "success",
    htmlUrl: "https://github.com/acme/app/actions/runs/123",
    runStartedAt: new Date(),
    createdAt: new Date(),
    repository: { owner: "acme", name: "app" },
  };

  it("returns runs with isAttested=false when no active attestation exists", async () => {
    (mockPrisma.workflowRun.findMany as jest.Mock).mockResolvedValue([RUN]);
    (mockPrisma.attestation.findMany as jest.Mock).mockResolvedValue([]);

    const app = buildApp();
    const res = await request(app).get("/api/v1/runs/recent");

    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].isAttested).toBe(false);
  });

  it("returns runs with isAttested=true when a matching active attestation exists", async () => {
    (mockPrisma.workflowRun.findMany as jest.Mock).mockResolvedValue([RUN]);
    (mockPrisma.attestation.findMany as jest.Mock).mockResolvedValue([
      {
        repositoryId: "repo-1",
        workflowPath: ".github/workflows/ci.yml",
      },
    ]);

    const app = buildApp();
    const res = await request(app).get("/api/v1/runs/recent");

    expect(res.status).toBe(200);
    expect(res.body.runs[0].isAttested).toBe(true);
  });

  it("respects the limit query parameter (max 50)", async () => {
    (mockPrisma.workflowRun.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.attestation.findMany as jest.Mock).mockResolvedValue([]);

    const app = buildApp();
    await request(app).get("/api/v1/runs/recent?limit=200");

    const findManyCall = (mockPrisma.workflowRun.findMany as jest.Mock).mock.calls[0][0];
    expect(findManyCall.take).toBe(50); // capped at 50
  });

  it("applies owner/repo filter when provided", async () => {
    (mockPrisma.workflowRun.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.attestation.findMany as jest.Mock).mockResolvedValue([]);

    const app = buildApp();
    await request(app).get("/api/v1/runs/recent?owner=acme&repo=app");

    const findManyCall = (mockPrisma.workflowRun.findMany as jest.Mock).mock.calls[0][0];
    expect(findManyCall.where).toEqual(
      expect.objectContaining({ repository: { owner: "acme", name: "app" } })
    );
  });

  it("returns empty runs when no workflow runs exist", async () => {
    (mockPrisma.workflowRun.findMany as jest.Mock).mockResolvedValue([]);
    (mockPrisma.attestation.findMany as jest.Mock).mockResolvedValue([]);

    const app = buildApp();
    const res = await request(app).get("/api/v1/runs/recent");

    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([]);
  });
});

// ── POST /attestations/batch ───────────────────────────────────────────────────

describe("POST /attestations/batch", () => {
  const VALID_ITEM = {
    repository: "acme/app",
    workflow_path: ".github/workflows/ci.yml",
  };

  beforeEach(() => {
    mockAuth.mockImplementation(async (req: any, _res: any, next: any) => {
      req.user = { login: "alice", id: 1 };
      req.token = "tok";
      next();
    });
    mockGetRepository.mockResolvedValue(makeRepo() as any);
    mockCreateAttestation.mockResolvedValue(makeAttestation() as any);
    (mockPrisma.attestation.findFirst as jest.Mock).mockResolvedValue(null);
  });

  it("returns 400 when attestations array is missing", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/v1/attestations/batch").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-empty array/);
  });

  it("returns 400 when attestations array is empty", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/v1/attestations/batch").send({ attestations: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-empty array/);
  });

  it("returns 400 when batch size exceeds 50", async () => {
    const items = Array.from({ length: 51 }, () => ({ ...VALID_ITEM }));
    const app = buildApp();
    const res = await request(app).post("/api/v1/attestations/batch").send({ attestations: items });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/50/);
  });

  it("returns 201 and creates all attestations when all items are valid", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/attestations/batch")
      .send({ attestations: [VALID_ITEM] });
    expect(res.status).toBe(201);
    expect(res.body.summary).toEqual({ created: 1, skipped: 0, errors: 0 });
    expect(res.body.results[0].status).toBe("created");
  });

  it("returns 207 with skipped when active attestation already exists", async () => {
    (mockPrisma.attestation.findFirst as jest.Mock).mockResolvedValue(makeAttestation());
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/attestations/batch")
      .send({ attestations: [VALID_ITEM] });
    expect(res.status).toBe(207);
    expect(res.body.summary.skipped).toBe(1);
    expect(res.body.results[0].status).toBe("skipped");
  });

  it("returns 207 with error when repository is not found", async () => {
    mockGetRepository.mockResolvedValue(null as any);
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/attestations/batch")
      .send({ attestations: [VALID_ITEM] });
    expect(res.status).toBe(207);
    expect(res.body.summary.errors).toBe(1);
    expect(res.body.results[0].status).toBe("error");
    expect(res.body.results[0].reason).toMatch(/not found/i);
  });

  it("returns per-item error for invalid workflow_path", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/attestations/batch")
      .send({
        attestations: [{ repository: "acme/app", workflow_path: "bad-path.yml" }],
      });
    expect(res.status).toBe(207);
    expect(res.body.results[0].status).toBe("error");
    expect(res.body.results[0].reason).toMatch(/workflow_path/);
  });

  it("returns per-item error for invalid repository format", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/attestations/batch")
      .send({
        attestations: [{ repository: "no-slash", workflow_path: ".github/workflows/ci.yml" }],
      });
    expect(res.status).toBe(207);
    expect(res.body.results[0].status).toBe("error");
    expect(res.body.results[0].reason).toMatch(/owner\/repo/);
  });

  it("returns mixed results for a batch with valid and invalid items", async () => {
    // First call's repo returns valid, second returns null (not installed)
    mockGetRepository.mockResolvedValueOnce(makeRepo() as any).mockResolvedValueOnce(null as any);

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/attestations/batch")
      .send({
        attestations: [
          VALID_ITEM,
          { repository: "acme/missing", workflow_path: ".github/workflows/ci.yml" },
        ],
      });
    expect(res.status).toBe(207);
    expect(res.body.summary.created).toBe(1);
    expect(res.body.summary.errors).toBe(1);
    // Results are sorted by original index
    expect(res.body.results[0].index).toBe(0);
    expect(res.body.results[1].index).toBe(1);
  });

  it("returns per-item error when notes exceed 1000 characters", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/attestations/batch")
      .send({
        attestations: [{ ...VALID_ITEM, notes: "x".repeat(1001) }],
      });
    expect(res.status).toBe(207);
    expect(res.body.results[0].status).toBe("error");
    expect(res.body.results[0].reason).toMatch(/notes/);
  });

  it("deduplicates repository DB lookups for identical repos", async () => {
    const app = buildApp();
    await request(app)
      .post("/api/v1/attestations/batch")
      .send({
        attestations: [
          VALID_ITEM,
          { repository: "acme/app", workflow_path: ".github/workflows/deploy.yml" },
        ],
      });
    // getRepository should only be called once for the same owner/name pair
    expect(mockGetRepository).toHaveBeenCalledTimes(1);
  });
});
