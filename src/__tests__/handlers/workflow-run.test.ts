import { handleWorkflowRun } from "../../handlers/workflow-run";

// ── Mock dependencies ──────────────────────────────────────────────────────────
jest.mock("../../services/gate");
jest.mock("../../services/attestation");
jest.mock("../../services/workflow-parser");
jest.mock("../../db/client", () => ({
  prisma: {
    workflowRun: {
      upsert: jest.fn(),
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  },
}));

import { checkGate, buildCheckOutput } from "../../services/gate";
import { ensureRepository } from "../../services/attestation";
import { parseWorkflowJobs } from "../../services/workflow-parser";
import { prisma } from "../../db/client";

const mockCheckGate = checkGate as jest.MockedFunction<typeof checkGate>;
const mockBuildCheckOutput = buildCheckOutput as jest.MockedFunction<typeof buildCheckOutput>;
const mockEnsureRepository = ensureRepository as jest.MockedFunction<typeof ensureRepository>;
const mockParseWorkflowJobs = parseWorkflowJobs as jest.MockedFunction<typeof parseWorkflowJobs>;
const mockPrisma = prisma as jest.Mocked<typeof prisma>;

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRepo() {
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
  };
}

function makeSummary() {
  return {
    owner: "acme",
    repo: "app",
    mode: "AUDIT" as any,
    checks: [],
    overallStatus: "pass" as const,
  };
}

function makeCheckOutput() {
  return {
    conclusion: "success" as const,
    title: "✅ All attested",
    summary: "All good",
  };
}

/**
 * Minimal mock Probot context for workflow_run.requested events.
 */
function makeContext(overrides: Record<string, unknown> = {}) {
  const checksCreate = jest.fn().mockResolvedValue({ data: {} });
  const reposGetContent = jest.fn().mockResolvedValue({
    data: {
      content: Buffer.from("jobs:\n  build:\n    runs-on: ubuntu-latest\n").toString("base64"),
      type: "file",
    },
  });

  return {
    repo: () => ({ owner: "acme", repo: "app" }),
    payload: {
      installation: { id: 10 },
      repository: { id: 1 },
      workflow_run: {
        id: 123,
        path: ".github/workflows/ci.yml",
        head_sha: "abc123",
        head_branch: "main",
        event: "push",
        status: "queued",
        conclusion: null,
        html_url: "https://github.com/acme/app/actions/runs/123",
        run_started_at: "2026-01-01T00:00:00Z",
      },
    },
    octokit: {
      repos: { getContent: reposGetContent },
      checks: { create: checksCreate },
    },
    log: {
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
    },
    ...overrides,
  } as unknown as Parameters<typeof handleWorkflowRun>[0];
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("handleWorkflowRun", () => {
  beforeEach(() => {
    mockEnsureRepository.mockResolvedValue(makeRepo() as any);
    mockCheckGate.mockResolvedValue(makeSummary() as any);
    mockBuildCheckOutput.mockReturnValue(makeCheckOutput());
    mockParseWorkflowJobs.mockReturnValue({ jobs: ["build"] });
    (mockPrisma.workflowRun.upsert as jest.Mock).mockResolvedValue({});
    (mockPrisma.workflowRun.findMany as jest.Mock).mockResolvedValue([]);
  });

  it("returns early and logs warning when no installationId is present", async () => {
    const ctx = makeContext();
    (ctx.payload as any).installation = undefined;

    await handleWorkflowRun(ctx);

    expect(ctx.log.warn).toHaveBeenCalled();
    expect(mockEnsureRepository).not.toHaveBeenCalled();
    expect(mockCheckGate).not.toHaveBeenCalled();
  });

  it("calls ensureRepository with correct params", async () => {
    const ctx = makeContext();

    await handleWorkflowRun(ctx);

    expect(mockEnsureRepository).toHaveBeenCalledWith("acme", "app", 1, 10);
  });

  it("posts a completed check run with the correct conclusion", async () => {
    const ctx = makeContext();

    await handleWorkflowRun(ctx);

    expect(ctx.octokit.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "app",
        name: "Action Gate / Workflow",
        head_sha: "abc123",
        status: "completed",
        conclusion: "success",
        output: expect.objectContaining({
          title: "✅ All attested",
          summary: "All good",
        }),
      })
    );
  });

  it("proceeds with empty jobs list when workflow YAML fetch fails", async () => {
    const ctx = makeContext();
    (ctx.octokit.repos.getContent as unknown as jest.Mock).mockRejectedValue(
      new Error("Not found")
    );

    await handleWorkflowRun(ctx);

    // checkGate should still be called, with jobs=[]
    expect(mockCheckGate).toHaveBeenCalledWith(
      "acme",
      "app",
      [{ path: ".github/workflows/ci.yml", jobs: [] }]
    );
  });

  it("passes parsed job names to checkGate", async () => {
    mockParseWorkflowJobs.mockReturnValue({ jobs: ["build", "test", "deploy"] });
    const ctx = makeContext();

    await handleWorkflowRun(ctx);

    expect(mockCheckGate).toHaveBeenCalledWith(
      "acme",
      "app",
      [{ path: ".github/workflows/ci.yml", jobs: ["build", "test", "deploy"] }]
    );
  });

  it("upserts the workflow run record after posting the check", async () => {
    const ctx = makeContext();

    await handleWorkflowRun(ctx);

    expect(mockPrisma.workflowRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { runId: "123" },
        create: expect.objectContaining({
          repositoryId: "repo-1",
          runId: "123",
          workflowPath: ".github/workflows/ci.yml",
          headBranch: "main",
          headSha: "abc123",
          event: "push",
          status: "queued",
        }),
      })
    );
  });

  it("prunes runs when the repo has more than 500", async () => {
    const oldDate = new Date("2025-01-01");
    (mockPrisma.workflowRun.findMany as jest.Mock).mockResolvedValue([
      { createdAt: oldDate },
    ]);
    (mockPrisma.workflowRun.deleteMany as jest.Mock).mockResolvedValue({ count: 5 });

    const ctx = makeContext();
    await handleWorkflowRun(ctx);

    expect(mockPrisma.workflowRun.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          repositoryId: "repo-1",
          createdAt: { lte: oldDate },
        }),
      })
    );
  });

  it("does not call deleteMany when repo has fewer than 500 runs", async () => {
    // findMany returns empty → no pruning needed
    (mockPrisma.workflowRun.findMany as jest.Mock).mockResolvedValue([]);

    const ctx = makeContext();
    await handleWorkflowRun(ctx);

    expect(mockPrisma.workflowRun.deleteMany).not.toHaveBeenCalled();
  });
});
