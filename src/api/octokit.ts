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

// Module-scoped credentials — set once at startup via setAppCredentials().
let _appId = "";
let _privateKey = "";

/** Store GitHub App credentials in module scope (avoids leaking to process.env). */
export function setAppCredentials(appId: string, privateKey: string): void {
  _appId = appId;
  _privateKey = privateKey;
}

/** Create an Octokit instance authenticated as a GitHub App installation. */
export function createInstallationOctokit(installationId: number): InstanceType<typeof Octokit> {
  return new RetryOctokit({
    authStrategy: createAppAuth,
    auth: {
      appId: _appId,
      privateKey: _privateKey,
      installationId,
    },
  });
}
