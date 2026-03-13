import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";

/**
 * Octokit enhanced with automatic retry and exponential backoff for:
 * - 429 Too Many Requests (GitHub secondary rate limits)
 * - 500, 502, 503 (transient server errors)
 *
 * Defaults to 3 retries with exponential backoff.
 */
export const RetryOctokit = Octokit.plugin(retry);
