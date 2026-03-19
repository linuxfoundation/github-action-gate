// SPDX-FileCopyrightText: 2026 The Linux Foundation
//
// SPDX-License-Identifier: Apache-2.0

import { handleWorkflowRun } from "../../handlers/workflow-run";

// ── Mock dependencies ──────────────────────────────────────────────────────────
// Prevent ESM-only octokit modules from being loaded when gate.ts is resolved.
jest.mock("@octokit/rest", () => {
  const MockOctokit = jest.fn();
  (MockOctokit as any).plugin = jest.fn().mockReturnValue(MockOctokit);
  return { Octokit: MockOctokit };
});
jest.mock("@octokit/plugin-retry", () => ({ retry: jest.fn() }));
jest.mock("@octokit/auth-app", () => ({ createAppAuth: jest.fn() }));
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
  const cancelWorkflowRun = jest.fn().mockResolvedValue({});

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
      rest: {
        repos: { getContent: reposGetContent },
        checks: { create: checksCreate },
        actions: { cancelWorkflowRun },
      },
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

    expect(ctx.octokit.rest.checks.create).toHaveBeenCalledWith(
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
    (ctx.octokit.rest.repos.getContent as unknown as jest.Mock).mockRejectedValue(
      new Error("Not found")
    );

    await handleWorkflowRun(ctx);

    // checkGate should still be called, with jobs=[]
    expect(mockCheckGate).toHaveBeenCalledWith("acme", "app", [
      { path: ".github/workflows/ci.yml", jobs: [] },
    ]);
  });

  it("passes parsed job names to checkGate", async () => {
    mockParseWorkflowJobs.mockReturnValue({ jobs: ["build", "test", "deploy"] });
    const ctx = makeContext();

    await handleWorkflowRun(ctx);

    expect(mockCheckGate).toHaveBeenCalledWith("acme", "app", [
      { path: ".github/workflows/ci.yml", jobs: ["build", "test", "deploy"] },
    ]);
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
    (mockPrisma.workflowRun.findMany as jest.Mock).mockResolvedValue([{ createdAt: oldDate }]);
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

  it("cancels the workflow run when gate fails in BLOCK mode", async () => {
    mockCheckGate.mockResolvedValue({
      owner: "acme",
      repo: "app",
      mode: "BLOCK" as any,
      checks: [],
      overallStatus: "fail" as const,
    } as any);
    mockBuildCheckOutput.mockReturnValue({
      conclusion: "failure" as const,
      title: "🚫 Blocked",
      summary: "Missing attestation",
    });

    const ctx = makeContext();
    await handleWorkflowRun(ctx);

    expect(ctx.octokit.rest.actions.cancelWorkflowRun).toHaveBeenCalledWith({
      owner: "acme",
      repo: "app",
      run_id: 123,
    });
  });

  it("does not cancel the workflow run when gate passes", async () => {
    const ctx = makeContext();
    await handleWorkflowRun(ctx);

    expect(ctx.octokit.rest.actions.cancelWorkflowRun).not.toHaveBeenCalled();
  });

  it("does not cancel the workflow run in audit mode (warn)", async () => {
    mockCheckGate.mockResolvedValue({
      owner: "acme",
      repo: "app",
      mode: "AUDIT" as any,
      checks: [],
      overallStatus: "warn" as const,
    } as any);
    mockBuildCheckOutput.mockReturnValue({
      conclusion: "neutral" as const,
      title: "⚠️ Audit warning",
      summary: "Missing attestation (audit mode)",
    });

    const ctx = makeContext();
    await handleWorkflowRun(ctx);

    expect(ctx.octokit.rest.actions.cancelWorkflowRun).not.toHaveBeenCalled();
  });
});
