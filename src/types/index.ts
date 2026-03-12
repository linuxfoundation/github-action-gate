// SQLite doesn't support Prisma native enums; these are stored as plain TEXT.
// Defining them locally keeps type safety throughout the codebase.
export enum GateMode {
  AUDIT = "AUDIT",
  BLOCK = "BLOCK",
}

export enum AttestationTier {
  USER = "USER",
  ORGANIZATION = "ORGANIZATION",
}

// ─── Domain types ─────────────────────────────────────────────────────────────

/** A workflow file and its list of job names, as parsed from the YAML. */
export interface WorkflowRef {
  /** Repo-relative path, e.g. ".github/workflows/ci.yml" */
  path: string;
  /** Job names declared in this workflow file. */
  jobs: string[];
}

/** Result for a single workflow-path / job-name combination. */
export interface GateCheckResult {
  workflowPath: string;
  /** null = workflow-level attestation (covers all jobs) */
  jobName: string | null;
  status: "attested" | "expired" | "unattested";
  attestationId?: string;
  voucherGithubLogin?: string;
  /** Self-reported company/org affiliation, e.g. "AMD" */
  voucherOrgAffiliation?: string | null;
  tier?: AttestationTier;
  /** For ORGANIZATION tier: the verified GitHub org */
  orgGithubLogin?: string | null;
  notes?: string | null;
  expiresAt?: Date;
  createdAt?: Date;
}

/** Aggregated gate decision for a repository + set of workflows. */
export interface GateSummary {
  owner: string;
  repo: string;
  mode: GateMode;
  checks: GateCheckResult[];
  /** pass = all attested; warn = audit mode with unattested; fail = block mode with unattested */
  overallStatus: "pass" | "warn" | "fail";
}

/** Output suitable for a GitHub check run. */
export interface CheckOutput {
  conclusion: "success" | "failure" | "neutral";
  title: string;
  summary: string;
}
