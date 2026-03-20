// SPDX-FileCopyrightText: 2026 The Linux Foundation
//
// SPDX-License-Identifier: Apache-2.0

import { Probot } from "probot";
import cors from "cors";
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { handlePullRequest } from "./handlers/pull-request.js";
import { handleWorkflowRun } from "./handlers/workflow-run.js";
import { handleWorkflowJob } from "./handlers/workflow-job.js";
import { createApiRouter, createAuthRouter } from "./api/routes.js";
import { ensureRepository } from "./services/attestation.js";

// Probot v14 passes { getRouter } as the second argument.
interface AppOptions {
  getRouter: (path?: string) => Router;
}

export default function actionGate(bot: Probot, { getRouter }: AppOptions) {
  // ── REST API ───────────────────────────────────────────────────────────────
  const router = getRouter("/");

  // CORS — restrict in production to your dashboard origin(s).
  const rawOrigins = process.env.CORS_ORIGINS?.trim();
  const allowedOrigins =
    rawOrigins && rawOrigins !== "*"
      ? rawOrigins
      : process.env.DASHBOARD_URL?.trim() || null;

  if (!allowedOrigins && process.env.NODE_ENV === "production") {
    bot.log.warn(
      "CORS_ORIGINS is not set and DASHBOARD_URL is missing — CORS will reject " +
        "cross-origin requests. Set CORS_ORIGINS to the dashboard origin(s)."
    );
  }
  router.use(
    cors(
      allowedOrigins
        ? {
            origin: allowedOrigins.split(",").map((o) => o.trim()),
            methods: ["GET", "POST", "DELETE", "PUT", "OPTIONS"],
          }
        : process.env.NODE_ENV === "production" ? { origin: false } : undefined
    )
  );

  // Security headers on every response from this router.
  router.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' https://avatars.githubusercontent.com data:; " +
        "connect-src 'self' https://github-action-gate.pytorch-foundation.workers.dev https://api.github.com https://github.com; " +
        "font-src 'self'; frame-ancestors 'none'; form-action 'self'"
    );
    res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
    next();
  });

  // Rate limiting — 100 requests per minute per IP on the API.
  const apiLimiter = rateLimit({
    windowMs: 60_000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests — please try again later" },
  });
  // Stricter limit for auth endpoints — 20 per minute per IP.
  const authLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many authentication requests — please try again later" },
  });

  router.use(express.json({ limit: "256kb" }));
  router.use("/api/v1", apiLimiter, createApiRouter());
  router.use("/auth", authLimiter, createAuthRouter());

  // Serve the static dashboard locally during development.
  if (process.env.NODE_ENV !== "production") {
    router.use("/dashboard", express.static("docs"));
    bot.log.info("Dashboard served at /dashboard (development mode)");
  }

  // ── Webhook event handlers ─────────────────────────────────────────────────

  // PR Gate: check attestations when workflow files are modified in a PR.
  bot.on(
    ["pull_request.opened", "pull_request.synchronize", "pull_request.reopened"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handlePullRequest as any
  );

  // Runtime Gate (workflow level): check attestations when a workflow is triggered.
  bot.on("workflow_run.requested", handleWorkflowRun);

  // Runtime Gate (job level): check attestations when an individual job is queued.
  bot.on("workflow_job.queued", handleWorkflowJob);

  // ── Installation lifecycle ─────────────────────────────────────────────────

  // When the app is installed on a new repository, seed its record.
  bot.on("installation_repositories.added", async (context) => {
    const installationId = context.payload.installation.id;
    for (const addedRepo of context.payload.repositories_added) {
      const [owner, name] = addedRepo.full_name.split("/");
      await ensureRepository(owner, name, addedRepo.id, installationId).catch((err) =>
        bot.log.error({ err }, `Failed to seed repo ${addedRepo.full_name}`)
      );
    }
  });

  bot.log.info("Action Gate is ready");
}
