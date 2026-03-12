import {
  checkAttestationStatus,
  createAttestation,
  listAttestations,
  ensureRepository,
  getRepository,
  revokeAttestation,
  CreateAttestationInput,
} from "../../services/attestation";
import { AttestationTier, GateMode } from "../../types";

// ── Mock Prisma ────────────────────────────────────────────────────────────────
jest.mock("../../db/client", () => ({
  prisma: {
    repository: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    attestation: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
  },
}));

import { prisma } from "../../db/client";

// Typed shortcuts
const mockAttestation = prisma.attestation as jest.Mocked<typeof prisma.attestation>;
const mockRepository = prisma.repository as jest.Mocked<typeof prisma.repository>;

// ── Shared fixtures ────────────────────────────────────────────────────────────

const REPO_ID = "repo-abc";
const WF_PATH = ".github/workflows/ci.yml";
const FUTURE = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);

function makeAttestation(overrides: Record<string, unknown> = {}) {
  return {
    id: "att-1",
    repositoryId: REPO_ID,
    workflowPath: WF_PATH,
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
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

// ── checkAttestationStatus ─────────────────────────────────────────────────────

describe("checkAttestationStatus", () => {
  it('returns "active" when an active (non-expired, non-revoked) attestation exists', async () => {
    const att = makeAttestation();
    (mockAttestation.findFirst as jest.Mock)
      .mockResolvedValueOnce(att)  // first call: active query
      .mockResolvedValueOnce(null); // second call: should not be reached

    const result = await checkAttestationStatus(REPO_ID, WF_PATH, null);

    expect(result.status).toBe("active");
    if (result.status === "active") {
      expect(result.attestation.id).toBe("att-1");
    }
    // Only the first findFirst should have been called
    expect(mockAttestation.findFirst).toHaveBeenCalledTimes(1);
  });

  it('returns "expired" when attestation exists but is past expiresAt', async () => {
    const expired = makeAttestation({ expiresAt: PAST });
    (mockAttestation.findFirst as jest.Mock)
      .mockResolvedValueOnce(null)     // active query returns nothing
      .mockResolvedValueOnce(expired); // expired query returns the record

    const result = await checkAttestationStatus(REPO_ID, WF_PATH, null);

    expect(result.status).toBe("expired");
    if (result.status === "expired") {
      expect(result.attestation.expiresAt).toEqual(PAST);
    }
  });

  it('returns "unattested" when no attestation record exists at all', async () => {
    (mockAttestation.findFirst as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const result = await checkAttestationStatus(REPO_ID, WF_PATH, "build");

    expect(result.status).toBe("unattested");
  });

  it("queries with the exact jobName passed in", async () => {
    (mockAttestation.findFirst as jest.Mock).mockResolvedValue(null);

    await checkAttestationStatus(REPO_ID, WF_PATH, "deploy");

    expect(mockAttestation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ jobName: "deploy" }),
      })
    );
  });

  it("normalises null jobName correctly", async () => {
    (mockAttestation.findFirst as jest.Mock).mockResolvedValue(null);

    await checkAttestationStatus(REPO_ID, WF_PATH, null);

    expect(mockAttestation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ jobName: null }),
      })
    );
  });
});

// ── createAttestation ─────────────────────────────────────────────────────────

describe("createAttestation", () => {
  const BASE_INPUT: CreateAttestationInput = {
    repositoryId: REPO_ID,
    workflowPath: WF_PATH,
    jobName: null,
    voucherGithubLogin: "alice",
    voucherGithubId: 1,
    tier: AttestationTier.USER,
    expiryDays: 90,
  };

  it("passes the correct fields to prisma.attestation.create", async () => {
    const returnValue = { ...makeAttestation(), repository: { owner: "acme", name: "app" } };
    (mockAttestation.create as jest.Mock).mockResolvedValue(returnValue);

    const before = new Date();
    await createAttestation(BASE_INPUT);
    const after = new Date();

    const createCall = (mockAttestation.create as jest.Mock).mock.calls[0][0];
    expect(createCall.data.repositoryId).toBe(REPO_ID);
    expect(createCall.data.workflowPath).toBe(WF_PATH);
    expect(createCall.data.voucherGithubLogin).toBe("alice");
    expect(createCall.data.tier).toBe(AttestationTier.USER);

    // expiresAt should be approximately 90 days from now
    const expiresAt: Date = createCall.data.expiresAt;
    const diffDays =
      (expiresAt.getTime() - before.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(89.9);
    expect(diffDays).toBeLessThanOrEqual(90.1);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after.getTime() + 90 * 24 * 60 * 60 * 1000 + 1000);
  });

  it("sets expiresAt to expiryDays days in the future", async () => {
    const returnValue = { ...makeAttestation(), repository: { owner: "acme", name: "app" } };
    (mockAttestation.create as jest.Mock).mockResolvedValue(returnValue);

    await createAttestation({ ...BASE_INPUT, expiryDays: 30 });

    const createCall = (mockAttestation.create as jest.Mock).mock.calls[0][0];
    const diffDays =
      (createCall.data.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(29.9);
    expect(diffDays).toBeLessThanOrEqual(30.1);
  });

  it("defaults optional fields to null when not provided", async () => {
    const returnValue = { ...makeAttestation(), repository: { owner: "acme", name: "app" } };
    (mockAttestation.create as jest.Mock).mockResolvedValue(returnValue);

    await createAttestation(BASE_INPUT); // no orgGithubLogin, notes, etc.

    const createCall = (mockAttestation.create as jest.Mock).mock.calls[0][0];
    expect(createCall.data.orgGithubLogin).toBeNull();
    expect(createCall.data.notes).toBeNull();
    expect(createCall.data.voucherOrgAffiliation).toBeNull();
  });
});

// ── revokeAttestation ─────────────────────────────────────────────────────────

describe("revokeAttestation", () => {
  it("calls prisma.attestation.update with revokedAt and revokedBy", async () => {
    const revoked = makeAttestation({ revokedAt: new Date(), revokedBy: "alice" });
    (mockAttestation.update as jest.Mock).mockResolvedValue(revoked);

    const before = new Date();
    await revokeAttestation("att-1", "alice");
    const after = new Date();

    const updateCall = (mockAttestation.update as jest.Mock).mock.calls[0][0];
    expect(updateCall.where.id).toBe("att-1");
    expect(updateCall.data.revokedBy).toBe("alice");

    const revokedAt: Date = updateCall.data.revokedAt;
    expect(revokedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(revokedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

// ── listAttestations ──────────────────────────────────────────────────────────

describe("listAttestations", () => {
  beforeEach(() => {
    (mockAttestation.findMany as jest.Mock).mockResolvedValue([]);
    (mockAttestation.count as jest.Mock).mockResolvedValue(0);
  });

  it("returns paginated results with defaults", async () => {
    const result = await listAttestations({});

    expect(result.page).toBe(1);
    expect(result.perPage).toBe(30);
    expect(result.total).toBe(0);
    expect(result.attestations).toEqual([]);
  });

  it("applies activeOnly filter (revokedAt=null + expiresAt > now)", async () => {
    await listAttestations({ activeOnly: true });

    const findManyCall = (mockAttestation.findMany as jest.Mock).mock.calls[0][0];
    expect(findManyCall.where.revokedAt).toBeNull();
    expect(findManyCall.where.expiresAt).toEqual(
      expect.objectContaining({ gt: expect.any(Date) })
    );
  });

  it("does not apply activeOnly filter when not set", async () => {
    await listAttestations({ activeOnly: false });

    const findManyCall = (mockAttestation.findMany as jest.Mock).mock.calls[0][0];
    expect(findManyCall.where.revokedAt).toBeUndefined();
    expect(findManyCall.where.expiresAt).toBeUndefined();
  });

  it("caps perPage at 100", async () => {
    await listAttestations({ perPage: 9999 });

    const findManyCall = (mockAttestation.findMany as jest.Mock).mock.calls[0][0];
    expect(findManyCall.take).toBe(100);
  });

  it("filters by workflowPath and voucherGithubLogin when provided", async () => {
    await listAttestations({
      workflowPath: WF_PATH,
      voucherGithubLogin: "alice",
    });

    const findManyCall = (mockAttestation.findMany as jest.Mock).mock.calls[0][0];
    expect(findManyCall.where.workflowPath).toBe(WF_PATH);
    expect(findManyCall.where.voucherGithubLogin).toBe("alice");
  });

  it("calculates correct skip for page 2", async () => {
    await listAttestations({ page: 2, perPage: 10 });

    const findManyCall = (mockAttestation.findMany as jest.Mock).mock.calls[0][0];
    expect(findManyCall.skip).toBe(10);
    expect(findManyCall.take).toBe(10);
  });
});

// ── ensureRepository ──────────────────────────────────────────────────────────

describe("ensureRepository", () => {
  it("upserts by githubId with correct defaults", async () => {
    const repoRecord = {
      id: REPO_ID,
      owner: "acme",
      name: "app",
      githubId: 42,
      installationId: 99,
      mode: GateMode.AUDIT,
      expiryDays: 180,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    (mockRepository.upsert as jest.Mock).mockResolvedValue(repoRecord);

    const result = await ensureRepository("acme", "app", 42, 99);

    expect(result).toEqual(repoRecord);
    const upsertCall = (mockRepository.upsert as jest.Mock).mock.calls[0][0];
    expect(upsertCall.where.githubId).toBe(42);
    expect(upsertCall.create.mode).toBe(GateMode.AUDIT);
    expect(upsertCall.create.expiryDays).toBe(180);
  });
});

// ── getRepository ─────────────────────────────────────────────────────────────

describe("getRepository", () => {
  it("queries by owner_name composite key", async () => {
    (mockRepository.findUnique as jest.Mock).mockResolvedValue(null);

    await getRepository("acme", "app");

    expect(mockRepository.findUnique).toHaveBeenCalledWith({
      where: { owner_name: { owner: "acme", name: "app" } },
    });
  });
});
