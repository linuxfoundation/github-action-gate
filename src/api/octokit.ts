// SPDX-FileCopyrightText: 2026 The Linux Foundation
//
// SPDX-License-Identifier: Apache-2.0

import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";
import { createAppAuth } from "@octokit/auth-app";

/**
 * Octokit enhanced with automatic retry and exponential backoff for:
 * - 429 Too Many Requests (GitHub secondary rate limits)
 * - 500, 502, 503 (transient server errors)
 *
 * Defaults to 3 retries with exponential backoff.
 */
export const RetryOctokit: typeof Octokit = Octokit.plugin(retry) as typeof Octokit;

/**
 * Create an Octokit instance authenticated as a GitHub App installation.
 * Requires APP_ID and PRIVATE_KEY to be set in process.env.
 */
export function createInstallationOctokit(installationId: number): InstanceType<typeof Octokit> {
  return new RetryOctokit({
    authStrategy: createAppAuth,
    auth: {
      appId: process.env.APP_ID ?? "",
      privateKey: process.env.PRIVATE_KEY ?? "",
      installationId,
    },
  });
}
