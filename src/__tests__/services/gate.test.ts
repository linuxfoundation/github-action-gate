import { buildCheckOutput, checkGate } from "../../services/gate";
import {
  AttestationTier,
  GateMode,
  GateSummary,
  GateCheckResult,
} from "../../types";

// ── Mock the attestation service ───────────────────────────────────────────────
jest.mock("../../services/attestation");

import {
  getRepository,
  checkAttestationStatus,
} from "../../services/attestation";

const mockGetRepository = getRepository as jest.MockedFunction<
  typeof getRepository
>;
const mockCheckAttestationStatus =
  checkAttestationStatus as jest.MockedFunction<typeof checkAttestationStatus>;

// ── Shared test data ───────────────────────────────────────────────────────────

const REPO = {
  id: "repo-1",
  owner: "acme",
  name: "my-app",
  githubId: 123,
  installationId: 456,
  mode: GateMode.AUDIT,
  expiryDays: 180,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const FUTURE = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);

interface FakeAttestation {
  id: string;
  repositoryId: string;
  workflowPath: string;
  jobName: string | null;
  voucherGithubLogin: string;
  voucherGithubId: number;
  voucherOrgAffiliation: string | null;
  tier: string;
  orgGithubLogin: string | null;
  notes: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeAttestation(overrides: Partial<FakeAttestation> = {}): FakeAttestation {
  return {
    id: "att-1",
    repositoryId: REPO.id,
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
    ...overrides,
  };
}

// ── buildCheckOutput ───────────────────────────────────────────────────────────

describe("buildCheckOutput", () => {
  const WORKFLOW = ".github/workflows/ci.yml";

  function makeSummary(
    overallStatus: GateSummary["overallStatus"],
    checks: GateCheckResult[],
    mode: GateMode = GateMode.AUDIT
  ): GateSummary {
    return { owner: "acme", repo: "my-app", mode, checks, overallStatus };
  }

  it("returns success conclusion when all checks are attested", () => {
    const check: GateCheckResult = {
      workflowPath: WORKFLOW,
      jobName: null,
      status: "attested",
      voucherGithubLogin: "alice",
      expiresAt: FUTURE,
      createdAt: new Date(),
      tier: AttestationTier.USER,
    };
    const summary = makeSummary("pass", [check]);
    const output = buildCheckOutput(summary);

    expect(output.conclusion).toBe("success");
    expect(output.title).toMatch(/1 workflow\/job/);
    expect(output.summary).toContain("alice");
  });

  it("returns neutral conclusion for warn (AUDIT mode with issues)", () => {
    const check: GateCheckResult = {
      workflowPath: WORKFLOW,
      jobName: "build",
      status: "unattested",
    };
    const summary = makeSummary("warn", [check], GateMode.AUDIT);
    const output = buildCheckOutput(summary);

    expect(output.conclusion).toBe("neutral");
    expect(output.title).toMatch(/audit mode/i);
    expect(output.summary).toContain("build");
  });

  it("returns failure conclusion for fail (BLOCK mode with issues)", () => {
    const check: GateCheckResult = {
      workflowPath: WORKFLOW,
      jobName: "deploy",
      status: "unattested",
    };
    const summary = makeSummary("fail", [check], GateMode.BLOCK);
    const output = buildCheckOutput(summary);

    expect(output.conclusion).toBe("failure");
    expect(output.title).toMatch(/require attestation/i);
    expect(output.summary).toContain("deploy");
  });

  it("renders expired checks in the issues table", () => {
    const check: GateCheckResult = {
      workflowPath: WORKFLOW,
      jobName: null,
      status: "expired",
      voucherGithubLogin: "bob",
      expiresAt: PAST,
      createdAt: new Date(),
      tier: AttestationTier.USER,
    };
    const summary = makeSummary("warn", [check]);
    const output = buildCheckOutput(summary);

    expect(output.conclusion).toBe("neutral");
    // Expired entries appear in the issues section
    expect(output.summary).toContain("🔄");
  });

  it("renders attested checks in a second table when issues also exist", () => {
    const attested: GateCheckResult = {
      workflowPath: WORKFLOW,
      jobName: "test",
      status: "attested",
      voucherGithubLogin: "alice",
      expiresAt: FUTURE,
      createdAt: new Date(),
      tier: AttestationTier.USER,
    };
    const unattested: GateCheckResult = {
      workflowPath: WORKFLOW,
      jobName: "deploy",
      status: "unattested",
    };
    const summary = makeSummary("warn", [attested, unattested]);
    const output = buildCheckOutput(summary);

    expect(output.summary).toContain("Attested");
    expect(output.summary).toContain("alice");
  });

  it("includes audit-mode notice in summary when mode is AUDIT and there are issues", () => {
    const check: GateCheckResult = {
      workflowPath: WORKFLOW,
      jobName: null,
      status: "unattested",
    };
    const summary = makeSummary("warn", [check], GateMode.AUDIT);
    const output = buildCheckOutput(summary);

    expect(output.summary).toMatch(/audit/i);
  });

  it("uses _entire workflow_ label when jobName is null in issues table", () => {
    const check: GateCheckResult = {
      workflowPath: WORKFLOW,
      jobName: null,
      status: "unattested",
    };
    const summary = makeSummary("warn", [check]);
    const output = buildCheckOutput(summary);

    expect(output.summary).toContain("_entire workflow_");
  });
});

// ── checkGate ─────────────────────────────────────────────────────────────────

describe("checkGate", () => {
  const WF = ".github/workflows/ci.yml";

  beforeEach(() => {
    mockGetRepository.mockResolvedValue(REPO as unknown as Awaited<ReturnType<typeof getRepository>>);
  });

  it("returns AUDIT/pass summary with empty checks when repository is not found", async () => {
    mockGetRepository.mockResolvedValue(null);

    const summary = await checkGate("acme", "my-app", [
      { path: WF, jobs: ["build"] },
    ]);

    expect(summary.mode).toBe(GateMode.AUDIT);
    // No checks → no issues → overallStatus is "pass" (nothing to block)
    expect(summary.overallStatus).toBe("pass");
    expect(summary.checks).toHaveLength(0);
    // attestation service should not be called
    expect(mockCheckAttestationStatus).not.toHaveBeenCalled();
  });

  it("returns pass when workflow-level attestation is active (skips per-job checks)", async () => {
    mockCheckAttestationStatus.mockResolvedValueOnce({
      status: "active",
      attestation: makeAttestation() as any,
    });

    const summary = await checkGate("acme", "my-app", [
      { path: WF, jobs: ["build", "test"] },
    ]);

    expect(summary.overallStatus).toBe("pass");
    expect(summary.checks).toHaveLength(1);
    expect(summary.checks[0].jobName).toBeNull();
    expect(summary.checks[0].status).toBe("attested");
    // One call for the workflow-level check; per-job checks skipped
    expect(mockCheckAttestationStatus).toHaveBeenCalledTimes(1);
  });

  it("falls through to per-job checks when workflow-level attestation is expired", async () => {
    const expiredAttestation = makeAttestation({ expiresAt: PAST });
    mockCheckAttestationStatus
      .mockResolvedValueOnce({ status: "expired", attestation: expiredAttestation as any })
      .mockResolvedValueOnce({ status: "active", attestation: makeAttestation({ jobName: "build" }) as any })
      .mockResolvedValueOnce({ status: "unattested" });

    const summary = await checkGate("acme", "my-app", [
      { path: WF, jobs: ["build", "test"] },
    ]);

    // expired workflow-level + attested build + unattested test
    expect(summary.checks).toHaveLength(3);
    expect(summary.checks.find((c) => c.jobName === null)?.status).toBe("expired");
    expect(summary.checks.find((c) => c.jobName === "build")?.status).toBe("attested");
    expect(summary.checks.find((c) => c.jobName === "test")?.status).toBe("unattested");
  });

  it("flags workflow path itself (jobName=null) when jobs array is empty and workflow is unattested", async () => {
    mockCheckAttestationStatus.mockResolvedValueOnce({ status: "unattested" });

    const summary = await checkGate("acme", "my-app", [{ path: WF, jobs: [] }]);

    expect(summary.checks).toHaveLength(1);
    expect(summary.checks[0].jobName).toBeNull();
    expect(summary.checks[0].status).toBe("unattested");
  });

  it("does not add an extra unattested check when jobs=[] and attestation is expired", async () => {
    const expiredAttestation = makeAttestation({ expiresAt: PAST });
    mockCheckAttestationStatus.mockResolvedValueOnce({
      status: "expired",
      attestation: expiredAttestation as any,
    });

    const summary = await checkGate("acme", "my-app", [{ path: WF, jobs: [] }]);

    // Only the expired workflow-level check; no duplicate unattested entry
    expect(summary.checks).toHaveLength(1);
    expect(summary.checks[0].status).toBe("expired");
  });

  it("produces fail overallStatus in BLOCK mode when checks are unattested", async () => {
    const blockRepo = { ...REPO, mode: GateMode.BLOCK };
    mockGetRepository.mockResolvedValue(blockRepo as unknown as Awaited<ReturnType<typeof getRepository>>);
    mockCheckAttestationStatus
      .mockResolvedValueOnce({ status: "unattested" }) // workflow-level
      .mockResolvedValueOnce({ status: "unattested" }); // per-job: "deploy"

    const summary = await checkGate("acme", "my-app", [
      { path: WF, jobs: ["deploy"] },
    ]);

    expect(summary.mode).toBe(GateMode.BLOCK);
    expect(summary.overallStatus).toBe("fail");
  });

  it("produces pass when all per-job checks are attested", async () => {
    mockCheckAttestationStatus
      .mockResolvedValueOnce({ status: "unattested" }) // workflow-level: no
      .mockResolvedValueOnce({ status: "active", attestation: makeAttestation({ jobName: "build" }) as any })
      .mockResolvedValueOnce({ status: "active", attestation: makeAttestation({ jobName: "test" }) as any });

    const summary = await checkGate("acme", "my-app", [
      { path: WF, jobs: ["build", "test"] },
    ]);

    expect(summary.overallStatus).toBe("pass");
    expect(summary.checks.every((c) => c.status === "attested")).toBe(true);
  });
});
