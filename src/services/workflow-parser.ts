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
  // Reject excessively large workflow files (>256 KB) to prevent abuse.
  if (content.length > 256_000) {
    return { jobs: [] };
  }

  let workflow: unknown;
  try {
    // Use JSON_SCHEMA to prevent YAML alias/anchor expansion ("billion laughs" bombs).
    // GitHub Actions YAML doesn't use anchors, so JSON_SCHEMA is sufficient.
    workflow = yaml.load(content, { schema: yaml.JSON_SCHEMA });
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
