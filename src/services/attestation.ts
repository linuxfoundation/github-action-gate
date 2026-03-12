import { Attestation, Prisma } from "@prisma/client";
import { AttestationTier, GateMode } from "../types";
import { prisma } from "../db/client";

// ─── Repository ───────────────────────────────────────────────────────────────

/** Upsert a repository record.  Called on every webhook event so the record
 *  is always present before we check attestations. */
export async function ensureRepository(
  owner: string,
  name: string,
  githubId: number,
  installationId: number
) {
  return prisma.repository.upsert({
    where: { githubId },
    update: { installationId, owner, name },
    create: {
      githubId,
      owner,
      name,
      installationId,
      mode: GateMode.AUDIT,
      expiryDays: 180,
    },
  });
}

export async function getRepository(owner: string, name: string) {
  return prisma.repository.findUnique({
    where: { owner_name: { owner, name } },
  });
}

export async function updateRepositoryConfig(
  owner: string,
  name: string,
  config: { mode?: GateMode; expiryDays?: number }
) {
  return prisma.repository.update({
    where: { owner_name: { owner, name } },
    data: config,
  });
}

// ─── Attestation status ───────────────────────────────────────────────────────

/**
 * Returns the most relevant attestation for a workflow+job pair:
 *  - "active"     → a valid, non-expired, non-revoked record exists
 *  - "expired"    → a record exists but has passed its expiry date
 *  - "unattested" → no record has ever been created
 */
export async function checkAttestationStatus(
  repositoryId: string,
  workflowPath: string,
  jobName: string | null
): Promise<
  | { status: "active"; attestation: Attestation }
  | { status: "expired"; attestation: Attestation }
  | { status: "unattested" }
> {
  // 1. Active check
  const active = await prisma.attestation.findFirst({
    where: {
      repositoryId,
      workflowPath,
      jobName: jobName ?? null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (active) return { status: "active", attestation: active };

  // 2. Expired (but not revoked) check
  const expired = await prisma.attestation.findFirst({
    where: {
      repositoryId,
      workflowPath,
      jobName: jobName ?? null,
      revokedAt: null,
    },
    orderBy: { expiresAt: "desc" },
  });
  if (expired) return { status: "expired", attestation: expired };

  return { status: "unattested" };
}

// ─── Create / revoke ──────────────────────────────────────────────────────────

export interface CreateAttestationInput {
  repositoryId: string;
  workflowPath: string;
  jobName?: string | null;
  voucherGithubLogin: string;
  voucherGithubId: number;
  voucherOrgAffiliation?: string | null;
  tier: AttestationTier;
  orgGithubLogin?: string | null;
  notes?: string | null;
  expiryDays: number;
}

export async function createAttestation(input: CreateAttestationInput) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + input.expiryDays);

  return prisma.attestation.create({
    data: {
      repositoryId: input.repositoryId,
      workflowPath: input.workflowPath,
      jobName: input.jobName ?? null,
      voucherGithubLogin: input.voucherGithubLogin,
      voucherGithubId: input.voucherGithubId,
      voucherOrgAffiliation: input.voucherOrgAffiliation ?? null,
      tier: input.tier,
      orgGithubLogin: input.orgGithubLogin ?? null,
      notes: input.notes ?? null,
      expiresAt,
    },
    include: { repository: { select: { owner: true, name: true } } },
  });
}

export async function revokeAttestation(id: string, revokedBy: string) {
  return prisma.attestation.update({
    where: { id },
    data: { revokedAt: new Date(), revokedBy },
  });
}

// ─── List ─────────────────────────────────────────────────────────────────────

export interface ListAttestationsFilters {
  owner?: string;
  repo?: string;
  workflowPath?: string;
  jobName?: string;
  voucherGithubLogin?: string;
  orgGithubLogin?: string;
  /** Only return non-expired, non-revoked records. */
  activeOnly?: boolean;
  page?: number;
  perPage?: number;
}

export async function listAttestations(filters: ListAttestationsFilters) {
  const where: Prisma.AttestationWhereInput = {};

  if (filters.owner !== undefined || filters.repo !== undefined) {
    where.repository = {};
    if (filters.owner) (where.repository as Prisma.RepositoryWhereInput).owner = filters.owner;
    if (filters.repo) (where.repository as Prisma.RepositoryWhereInput).name = filters.repo;
  }
  if (filters.workflowPath) where.workflowPath = filters.workflowPath;
  if (filters.jobName !== undefined) where.jobName = filters.jobName;
  if (filters.voucherGithubLogin) where.voucherGithubLogin = filters.voucherGithubLogin;
  if (filters.orgGithubLogin) where.orgGithubLogin = filters.orgGithubLogin;

  if (filters.activeOnly) {
    where.revokedAt = null;
    where.expiresAt = { gt: new Date() };
  }

  const page = Math.max(1, filters.page ?? 1);
  const perPage = Math.min(filters.perPage ?? 30, 100);
  const skip = (page - 1) * perPage;

  const [attestations, total] = await Promise.all([
    prisma.attestation.findMany({
      where,
      include: { repository: { select: { owner: true, name: true } } },
      orderBy: { createdAt: "desc" },
      skip,
      take: perPage,
    }),
    prisma.attestation.count({ where }),
  ]);

  return { attestations, total, page, perPage };
}
