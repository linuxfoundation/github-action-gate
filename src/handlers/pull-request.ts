import { Context } from "probot";
import { parseWorkflowJobs } from "../services/workflow-parser";
import { checkGate, buildCheckOutput } from "../services/gate";
import { ensureRepository } from "../services/attestation";
import { WorkflowRef } from "../types";

const WORKFLOW_PATH_RE = /^\.github\/workflows\/.+\.ya?ml$/;
const CHECK_NAME = "Action Gate";

// Use a looser type so TypeScript doesn't create an unwieldy union.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PRContext = Context<any>;

/**
 * PR Gate — fires when a PR is opened, updated, or reopened.
 *
 * If the PR modifies any workflow files, we:
 *  1. Parse each modified workflow file to extract job names.
 *  2. Check attestation status for every workflow/job pair.
 *  3. Create (or update) a check run on the PR head SHA.
 */
export async function handlePullRequest(context: PRContext) {
  const { owner, repo } = context.repo() as { owner: string; repo: string };
  const pr = (context.payload as { pull_request: { number: number; head: { sha: string } } })
    .pull_request;
  const headSha = pr.head.sha;
  const installationId = (context.payload as { installation?: { id: number } }).installation?.id;

  if (!installationId) {
    context.log.warn("No installation ID on pull_request payload — skipping");
    return;
  }

  await ensureRepository(
    owner,
    repo,
    (context.payload as { repository: { id: number } }).repository.id,
    installationId
  );

  // Determine which workflow files this PR touches.
  const { data: files } = await context.octokit.pulls.listFiles({
    owner,
    repo,
    pull_number: pr.number,
    per_page: 100,
  });

  const workflowFiles = files.filter(
    (f) => WORKFLOW_PATH_RE.test(f.filename) && f.status !== "removed"
  );

  if (workflowFiles.length === 0) return;

  // Open a pending check run so GitHub shows "in progress" immediately.
  const { data: checkRun } = await context.octokit.checks.create({
    owner,
    repo,
    name: CHECK_NAME,
    head_sha: headSha,
    status: "in_progress",
    started_at: new Date().toISOString(),
  });

  // Parse workflow YAML to get job names.
  const workflows: WorkflowRef[] = [];
  for (const file of workflowFiles) {
    try {
      const { data: content } = await context.octokit.repos.getContent({
        owner,
        repo,
        path: file.filename,
        ref: headSha,
      });
      if ("content" in content && typeof content.content === "string") {
        const decoded = Buffer.from(content.content, "base64").toString("utf-8");
        const parsed = parseWorkflowJobs(decoded);
        workflows.push({ path: file.filename, jobs: parsed.jobs });
      } else {
        workflows.push({ path: file.filename, jobs: [] });
      }
    } catch {
      // Treat unparseable files as having unknown jobs.
      workflows.push({ path: file.filename, jobs: [] });
    }
  }

  const summary = await checkGate(owner, repo, workflows);
  const output = buildCheckOutput(summary);

  await context.octokit.checks.update({
    owner,
    repo,
    check_run_id: checkRun.id,
    status: "completed",
    completed_at: new Date().toISOString(),
    conclusion: output.conclusion,
    output: {
      title: output.title,
      summary: output.summary,
    },
  });
}
