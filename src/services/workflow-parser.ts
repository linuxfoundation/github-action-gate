import * as yaml from "js-yaml";

export interface ParsedWorkflow {
  /** The `name:` field at the top of the workflow file, if present. */
  name?: string;
  /** Names of all jobs declared under `jobs:`. */
  jobs: string[];
}

/**
 * Parse a GitHub Actions workflow YAML file and return the workflow name
 * and the list of job IDs defined in it.  Never throws — returns an empty
 * result on malformed input.
 */
export function parseWorkflowJobs(content: string): ParsedWorkflow {
  let workflow: unknown;
  try {
    workflow = yaml.load(content);
  } catch {
    return { jobs: [] };
  }

  if (!workflow || typeof workflow !== "object") {
    return { jobs: [] };
  }

  const w = workflow as Record<string, unknown>;
  const jobs =
    w.jobs && typeof w.jobs === "object" ? Object.keys(w.jobs as Record<string, unknown>) : [];

  return {
    name: typeof w.name === "string" ? w.name : undefined,
    jobs,
  };
}
