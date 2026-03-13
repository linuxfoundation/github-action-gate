import { Context } from "probot";
import { parseWorkflowJobs } from "../services/workflow-parser";
import { checkGate, buildCheckOutput } from "../services/gate";
import { ensureRepository } from "../services/attestation";
import { prisma } from "../db/client";

const CHECK_NAME = "Action Gate / Workflow";

/**
 * Runtime Gate (workflow level) — fires when a workflow run is requested.
 *
 * We read the workflow YAML at the triggering SHA to get the job list, then
 * run the same attestation check as the PR gate and post a check run.
 *
 * To actually block execution, configure this check run's name as a required
 * status check on the relevant branch protection rule.
 */
export async function handleWorkflowRun(context: Context<"workflow_run.requested">) {
  const { owner, repo } = context.repo();
  const run = context.payload.workflow_run;
  const installationId = context.payload.installation?.id;

  if (!installationId) {
    context.log.warn("No installation ID on workflow_run payload — skipping");
    return;
  }

  const repository = await ensureRepository(
    owner,
    repo,
    context.payload.repository.id,
    installationId
  );

  // Fetch the workflow file at the exact SHA that triggered this run.
  let jobs: string[] = [];
  try {
    const { data: content } = await context.octokit.repos.getContent({
      owner,
      repo,
      path: run.path,
      ref: run.head_sha,
    });
    if ("content" in content && typeof content.content === "string") {
      const decoded = Buffer.from(content.content, "base64").toString("utf-8");
      jobs = parseWorkflowJobs(decoded).jobs;
    }
  } catch {
    // Proceed with empty job list — gate will check the workflow level.
  }

  const summary = await checkGate(owner, repo, [{ path: run.path, jobs }]);
  const output = buildCheckOutput(summary);

  await context.octokit.checks.create({
    owner,
    repo,
    name: CHECK_NAME,
    head_sha: run.head_sha,
    status: "completed",
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    conclusion: output.conclusion,
    output: {
      title: output.title,
      summary: output.summary,
    },
  });

  // ── Persist run record ────────────────────────────────────────────────────
  await prisma.workflowRun
    .upsert({
      where: { runId: String(run.id) },
      create: {
        repositoryId: repository.id,
        runId: String(run.id),
        workflowPath: run.path,
        headBranch: run.head_branch ?? null,
        headSha: run.head_sha,
        event: run.event,
        status: run.status,
        conclusion: run.conclusion ?? null,
        htmlUrl: run.html_url ?? null,
        runStartedAt: run.run_started_at ? new Date(run.run_started_at) : null,
      },
      update: {
        status: run.status,
        conclusion: run.conclusion ?? null,
      },
    })
    .catch((err) => context.log.warn({ err }, "Failed to persist workflow run"));

  // Prune runs older than the most recent 500 for this repo.
  const oldest = await prisma.workflowRun.findMany({
    where: { repositoryId: repository.id },
    orderBy: { createdAt: "desc" },
    skip: 500,
    take: 1,
    select: { createdAt: true },
  });
  if (oldest.length > 0) {
    await prisma.workflowRun
      .deleteMany({
        where: {
          repositoryId: repository.id,
          createdAt: { lte: oldest[0].createdAt },
        },
      })
      .catch(() => {});
  }
}
