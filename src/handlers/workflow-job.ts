import { Context } from "probot";
import { checkGate, buildCheckOutput } from "../services/gate";
import { ensureRepository } from "../services/attestation";

const CHECK_NAME_PREFIX = "Action Gate / Job";

/**
 * Runtime Gate (job level) — fires when an individual workflow job is queued.
 *
 * We look up the workflow file path from the associated workflow run, then
 * check attestation status for this specific job.  A separate check run is
 * created for each job so reviewers can see exactly which jobs need vouching.
 *
 * Add "Action Gate / Job: <jobName>" as a required status check in your
 * branch protection settings to actually gate merges/runs on this check.
 */
export async function handleWorkflowJob(context: Context<"workflow_job.queued">) {
  const { owner, repo } = context.repo();
  const job = context.payload.workflow_job;
  const installationId = context.payload.installation?.id;

  if (!installationId) {
    context.log.warn("No installation ID on workflow_job payload — skipping");
    return;
  }

  await ensureRepository(owner, repo, context.payload.repository.id, installationId);

  // Fetch the parent workflow run to get the workflow file path.
  let workflowPath: string;
  try {
    const { data: run } = await context.octokit.actions.getWorkflowRun({
      owner,
      repo,
      run_id: job.run_id,
    });
    workflowPath = run.path;
  } catch (err) {
    context.log.warn(
      { err },
      `Could not fetch workflow run ${job.run_id} to resolve file path — skipping job gate`
    );
    return;
  }

  const summary = await checkGate(owner, repo, [{ path: workflowPath, jobs: [job.name] }]);
  const output = buildCheckOutput(summary);

  await context.octokit.checks.create({
    owner,
    repo,
    // Include the job name so each job gets its own distinct check entry.
    name: `${CHECK_NAME_PREFIX}: ${job.name}`,
    head_sha: job.head_sha,
    status: "completed",
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    conclusion: output.conclusion,
    output: {
      title: output.title,
      summary: output.summary,
    },
  });
}
