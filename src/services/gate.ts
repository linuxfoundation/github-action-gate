import { GateMode } from "../types";
import { checkAttestationStatus, getRepository } from "./attestation";
import { AttestationTier, CheckOutput, GateCheckResult, GateSummary, WorkflowRef } from "../types";

// ─── Core gate logic ─────────────────────────────────────────────────────────

/**
 * For a given repository + list of workflows (each with their job names),
 * look up attestation status for every workflow/job pair and return a
 * GateSummary with an overallStatus of "pass", "warn", or "fail".
 *
 * Rules:
 *  - A workflow-level attestation covers all jobs in that file.
 *  - If there is no workflow-level attestation, every job is checked individually.
 *  - The repo's GateMode (AUDIT/BLOCK) determines whether missing attestations
 *    produce a "warn" or "fail" overall status.
 */
export async function checkGate(
  owner: string,
  repo: string,
  workflows: WorkflowRef[]
): Promise<GateSummary> {
  const repository = await getRepository(owner, repo);

  // Repository hasn't been configured yet — default to AUDIT to avoid false blocks.
  if (!repository) {
    return buildSummary(owner, repo, GateMode.AUDIT, []);
  }

  const checks: GateCheckResult[] = [];

  for (const workflow of workflows) {
    // Check for a workflow-level attestation first (covers all jobs).
    const wfResult = await checkAttestationStatus(repository.id, workflow.path, null);

    if (wfResult.status === "active") {
      const a = wfResult.attestation;
      checks.push({
        workflowPath: workflow.path,
        jobName: null,
        status: "attested",
        attestationId: a.id,
        voucherGithubLogin: a.voucherGithubLogin,
        voucherOrgAffiliation: a.voucherOrgAffiliation,
        tier: a.tier as AttestationTier,
        orgGithubLogin: a.orgGithubLogin,
        notes: a.notes,
        expiresAt: a.expiresAt,
        createdAt: a.createdAt,
      });
      // Workflow-level attestation covers all jobs — skip per-job checks.
      continue;
    }

    if (wfResult.status === "expired") {
      const a = wfResult.attestation;
      checks.push({
        workflowPath: workflow.path,
        jobName: null,
        status: "expired",
        attestationId: a.id,
        voucherGithubLogin: a.voucherGithubLogin,
        voucherOrgAffiliation: a.voucherOrgAffiliation,
        tier: a.tier as AttestationTier,
        orgGithubLogin: a.orgGithubLogin,
        notes: a.notes,
        expiresAt: a.expiresAt,
        createdAt: a.createdAt,
      });
      // Still check individual jobs in case some have fresh attestations.
    }

    // Per-job checks.
    if (workflow.jobs.length === 0) {
      // We couldn't parse the workflow — flag the workflow path itself.
      if (wfResult.status !== "expired") {
        checks.push({
          workflowPath: workflow.path,
          jobName: null,
          status: "unattested",
        });
      }
    } else {
      for (const jobName of workflow.jobs) {
        const jobResult = await checkAttestationStatus(repository.id, workflow.path, jobName);

        if (jobResult.status === "active") {
          const a = jobResult.attestation;
          checks.push({
            workflowPath: workflow.path,
            jobName,
            status: "attested",
            attestationId: a.id,
            voucherGithubLogin: a.voucherGithubLogin,
            voucherOrgAffiliation: a.voucherOrgAffiliation,
            tier: a.tier as AttestationTier,
            orgGithubLogin: a.orgGithubLogin,
            notes: a.notes,
            expiresAt: a.expiresAt,
            createdAt: a.createdAt,
          });
        } else if (jobResult.status === "expired") {
          const a = jobResult.attestation;
          checks.push({
            workflowPath: workflow.path,
            jobName,
            status: "expired",
            attestationId: a.id,
            voucherGithubLogin: a.voucherGithubLogin,
            voucherOrgAffiliation: a.voucherOrgAffiliation,
            tier: a.tier as AttestationTier,
            orgGithubLogin: a.orgGithubLogin,
            notes: a.notes,
            expiresAt: a.expiresAt,
            createdAt: a.createdAt,
          });
        } else {
          checks.push({
            workflowPath: workflow.path,
            jobName,
            status: "unattested",
          });
        }
      }
    }
  }

  return buildSummary(owner, repo, repository.mode as GateMode, checks);
}

function buildSummary(
  owner: string,
  repo: string,
  mode: GateMode,
  checks: GateCheckResult[]
): GateSummary {
  const hasIssues = checks.some((c) => c.status !== "attested");
  let overallStatus: GateSummary["overallStatus"];

  if (!hasIssues) {
    overallStatus = "pass";
  } else if (mode === GateMode.AUDIT) {
    overallStatus = "warn";
  } else {
    overallStatus = "fail";
  }

  return { owner, repo, mode, checks, overallStatus };
}

// ─── Check run output builder ─────────────────────────────────────────────────

/**
 * Escape characters that could break a GitHub Markdown table cell.
 * Prevents injection via user-controlled free-text fields (e.g. org affiliation,
 * job names) which are embedded in check run output tables.
 */
function escapeMdCell(s: string | null | undefined): string {
  if (s == null) return "—";
  return String(s)
    .replace(/[|`\\]/g, (ch) => `\\${ch}`)
    .replace(/[\r\n]/g, " ");
}

/**
 * Convert a GateSummary into parameters suitable for a GitHub check run output.
 */
export function buildCheckOutput(summary: GateSummary): CheckOutput {
  const attested = summary.checks.filter((c) => c.status === "attested");
  const expired = summary.checks.filter((c) => c.status === "expired");
  const unattested = summary.checks.filter((c) => c.status === "unattested");
  const issues = [...expired, ...unattested];

  const dashboardUrl = process.env.DASHBOARD_URL ?? "";

  let conclusion: CheckOutput["conclusion"];
  let title: string;

  if (summary.overallStatus === "pass") {
    conclusion = "success";
    title = `✅ All ${attested.length} workflow/job(s) attested`;
  } else if (summary.overallStatus === "warn") {
    conclusion = "neutral";
    title = `⚠️ ${issues.length} workflow/job(s) need attestation (audit mode — not blocking)`;
  } else {
    conclusion = "failure";
    title = `🚫 ${issues.length} workflow/job(s) require attestation before merging`;
  }

  const lines: string[] = [];

  if (issues.length > 0) {
    lines.push("## Workflows / Jobs Needing Attestation");
    lines.push("");
    lines.push("| Workflow | Job | Status |");
    lines.push("| --- | --- | --- |");
    for (const c of issues) {
      const job = c.jobName != null ? escapeMdCell(c.jobName) : "_entire workflow_";
      const badge = c.status === "expired" ? "🔄 Expired" : "❌ Unattested";
      lines.push(`| \`${escapeMdCell(c.workflowPath)}\` | ${job} | ${badge} |`);
    }
    lines.push("");
    if (dashboardUrl) {
      lines.push(
        `To vouch for these, visit the **[Action Gate Dashboard](${dashboardUrl})** or use the [REST API](${process.env.API_BASE_URL ?? ""}/api/v1/attestations).`
      );
    } else {
      lines.push("To vouch, create an attestation via the Action Gate REST API.");
    }
    lines.push("");
  }

  if (attested.length > 0) {
    lines.push("## Attested Workflows / Jobs");
    lines.push("");
    lines.push("| Workflow | Job | Voucher | Affiliation | Expires |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const c of attested) {
      const job = c.jobName != null ? escapeMdCell(c.jobName) : "_entire workflow_";
      const voucher = c.orgGithubLogin
        ? `@${escapeMdCell(c.orgGithubLogin)} (org)`
        : `@${escapeMdCell(c.voucherGithubLogin) || "?"}`;
      const affil = escapeMdCell(c.voucherOrgAffiliation);
      const exp = c.expiresAt ? c.expiresAt.toISOString().split("T")[0] : "—";
      lines.push(
        `| \`${escapeMdCell(c.workflowPath)}\` | ${job} | ${voucher} | ${affil} | ${exp} |`
      );
    }
    lines.push("");
  }

  if (summary.mode === GateMode.AUDIT && issues.length > 0) {
    lines.push(
      "> **Audit mode** is active for this repository. Unattested workflows are " +
        "flagged but not blocked. A repository admin can switch to `BLOCK` mode " +
        "via the Action Gate API."
    );
  }

  return { conclusion, title, summary: lines.join("\n") };
}
