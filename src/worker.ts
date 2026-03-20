// SPDX-FileCopyrightText: 2026 The Linux Foundation
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Cloudflare Worker entry point for Action Gate.
 *
 * Replaces the Probot/Express server with a lightweight fetch handler that:
 *  - Verifies GitHub webhook signatures
 *  - Routes API, auth, and webhook requests
 *  - Uses D1 via the Prisma adapter for every request
 *
 * The existing service layer (attestation, gate, workflow-parser) and handlers
 * (pull-request, workflow-run, workflow-job) are reused as-is — they import
 * `prisma` from `db/client`, which is swapped per-request via `setPrisma()`.
 */

import { createD1Client, setPrisma } from "./db/client.js";
import { createApiRouter, createAuthRouter } from "./api/routes.js";
import { setAppCredentials } from "./api/octokit.js";
import { handlePullRequest } from "./handlers/pull-request.js";
import { handleWorkflowRun } from "./handlers/workflow-run.js";
import { handleWorkflowJob } from "./handlers/workflow-job.js";
import { ensureRepository } from "./services/attestation.js";
import { logger } from "./logger.js";
import { Readable } from "node:stream";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import cors from "cors";
import express from "express";

// ── Env type ──────────────────────────────────────────────────────────────────

interface Env {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DB: any; // Cloudflare D1Database binding
  APP_ID: string;
  PRIVATE_KEY: string;
  WEBHOOK_SECRET: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  API_BASE_URL?: string;
  DASHBOARD_URL?: string;
  CORS_ORIGINS?: string;
  NODE_ENV?: string;
}

// ── Webhook signature verification ────────────────────────────────────────────

async function verifyWebhookSignature(
  secret: string,
  payload: string,
  signatureHeader: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const expected = "sha256=" + [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison
  if (expected.length !== signatureHeader.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return mismatch === 0;
}

// ── PKCS#1 → PKCS#8 key conversion ────────────────────────────────────────────
// GitHub App private keys are PKCS#1 ("BEGIN RSA PRIVATE KEY"), but
// universal-github-app-jwt's Web Crypto path only supports PKCS#8.
// Wrangler resolves the #crypto conditional import to the non-Node path even
// with nodejs_compat, so we convert the key ourselves using pure DER/ASN.1.

function derLength(length: number): Uint8Array {
  if (length < 128) return new Uint8Array([length]);
  const bytes: number[] = [];
  let tmp = length;
  while (tmp > 0) { bytes.unshift(tmp & 0xff); tmp >>= 8; }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function wrapDer(tag: number, data: Uint8Array): Uint8Array {
  const len = derLength(data.length);
  const result = new Uint8Array(1 + len.length + data.length);
  result[0] = tag;
  result.set(len, 1);
  result.set(data, 1 + len.length);
  return result;
}

function ensurePkcs8(pem: string): string {
  if (!pem.includes("-----BEGIN RSA PRIVATE KEY-----")) return pem;

  // Extract the base64 body, stripping ALL non-base64 characters
  const b64 = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
    .replace(/-----END RSA PRIVATE KEY-----/, "")
    .replace(/[^A-Za-z0-9+/=]/g, "");
  const pkcs1Der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  // rsaEncryption OID: 1.2.840.113549.1.1.1
  const algorithmId = new Uint8Array([
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  ]);
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const privateKeyOctet = wrapDer(0x04, pkcs1Der);

  // Concatenate: version + algorithmId + octetString(pkcs1)
  const inner = new Uint8Array(version.length + algorithmId.length + privateKeyOctet.length);
  inner.set(version, 0);
  inner.set(algorithmId, version.length);
  inner.set(privateKeyOctet, version.length + algorithmId.length);

  const pkcs8Der = wrapDer(0x30, inner);
  const pkcs8B64 = btoa(String.fromCharCode(...pkcs8Der));

  // Format as PEM with 64-char lines
  const lines = pkcs8B64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

// ── Probot-compatible context builder ─────────────────────────────────────────

/**
 * Build a minimal Probot-like `context` object from a raw webhook payload
 * so that the existing handler functions work unchanged.
 */
function buildContext(event: string, payload: Record<string, unknown>, env: Env) {
  const installationId =
    (payload.installation as { id?: number } | undefined)?.id;

  const privateKey = ensurePkcs8(env.PRIVATE_KEY.replace(/\\n/g, "\n"));

  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: env.APP_ID,
      privateKey,
      installationId,
    },
  });

  const repo = payload.repository as { owner: { login: string }; name: string; id: number } | undefined;

  return {
    name: event,
    payload,
    octokit,
    repo: () => ({
      owner: repo?.owner?.login ?? "",
      repo: repo?.name ?? "",
    }),
    log: logger,
  };
}

// ── Express app factory ───────────────────────────────────────────────────────

function buildExpressApp(env: Env): express.Express {
  const app = express();

  // Store app credentials in module scope (not process.env) to limit exposure.
  setAppCredentials(env.APP_ID ?? "", ensurePkcs8((env.PRIVATE_KEY ?? "").replace(/\\n/g, "\n")));

  // Expose non-secret env vars so existing code that reads process.env works.
  if (typeof process !== "undefined" && process.env) {
    process.env.GITHUB_CLIENT_ID = env.GITHUB_CLIENT_ID ?? "";
    process.env.GITHUB_CLIENT_SECRET = env.GITHUB_CLIENT_SECRET ?? "";
    process.env.API_BASE_URL = env.API_BASE_URL ?? "";
    process.env.DASHBOARD_URL = env.DASHBOARD_URL ?? "";
    process.env.WEBHOOK_SECRET = env.WEBHOOK_SECRET ?? "";
  }

  // CORS
  const rawOrigins = env.CORS_ORIGINS?.trim();
  const allowedOrigins =
    rawOrigins && rawOrigins !== "*"
      ? rawOrigins
      : env.DASHBOARD_URL?.trim() || null;

  if (!allowedOrigins) {
    logger.warn("CORS_ORIGINS is not set and DASHBOARD_URL is missing — CORS will reject cross-origin requests. " +
      "Set CORS_ORIGINS to the dashboard origin(s) or DASHBOARD_URL to allow cross-origin API access.");
  }

  app.use(
    cors(
      allowedOrigins
        ? {
            origin: allowedOrigins.split(",").map((o) => o.trim()),
            methods: ["GET", "POST", "DELETE", "PUT", "OPTIONS"],
          }
        : { origin: false }
    )
  );

  // Security headers
  app.use((_req, res, next) => {
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

  // Note: express-rate-limit is not effective on Cloudflare Workers because
  // each isolate has its own in-memory store that resets unpredictably.
  // Use Cloudflare's built-in rate limiting rules (WAF → Rate Limiting) for
  // production rate limiting.  The middleware is intentionally omitted here.

  app.use(express.json({ limit: "256kb" }));
  app.use("/api/v1", createApiRouter());
  app.use("/auth", createAuthRouter());

  return app;
}

// ── Webhook dispatcher ────────────────────────────────────────────────────────

async function handleWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  const event = request.headers.get("x-github-event") ?? "";
  const body = await request.text();

  if (!signature || !event) {
    return new Response(JSON.stringify({ error: "Missing webhook headers" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const valid = await verifyWebhookSignature(env.WEBHOOK_SECRET, body, signature);
  if (!valid) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const payload = JSON.parse(body) as Record<string, unknown>;
  const action = payload.action as string | undefined;
  const eventAction = action ? `${event}.${action}` : event;

  try {
    const context = buildContext(event, payload, env);

    // Dispatch to the appropriate handler based on event + action
    switch (eventAction) {
      case "pull_request.opened":
      case "pull_request.synchronize":
      case "pull_request.reopened":
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await handlePullRequest(context as any);
        break;

      case "workflow_run.requested":
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await handleWorkflowRun(context as any);
        break;

      case "workflow_job.queued":
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await handleWorkflowJob(context as any);
        break;

      case "installation_repositories.added": {
        const installationId = (payload.installation as { id: number }).id;
        const repos = payload.repositories_added as Array<{
          full_name: string;
          id: number;
        }>;
        for (const addedRepo of repos) {
          const [owner, name] = addedRepo.full_name.split("/");
          await ensureRepository(owner, name, addedRepo.id, installationId).catch((err) =>
            logger.error({ err }, `Failed to seed repo ${addedRepo.full_name}`)
          );
        }
        break;
      }

      default:
        logger.info({ eventAction }, "Ignoring unhandled event");
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logger.error({ err: message, stack, eventAction }, "Webhook handler error");
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ── Express-to-fetch adapter ──────────────────────────────────────────────────

/**
 * Convert a Web API Request into a Node-style invocation of the Express app
 * and return a Web API Response.
 */
function expressToFetchResponse(
  app: express.Express,
  request: Request
): Promise<Response> {
  return new Promise((resolve) => {
    const url = new URL(request.url);

    // Build a minimal Node IncomingMessage-like object
    const bodyStream = new Readable({ read() {} });
    const req = Object.assign(bodyStream, {
      method: request.method,
      url: url.pathname + url.search,
      headers: Object.fromEntries(request.headers.entries()),
      connection: { remoteAddress: request.headers.get("cf-connecting-ip") ?? "0.0.0.0" },
      socket: { remoteAddress: request.headers.get("cf-connecting-ip") ?? "0.0.0.0" },
    });

    // Build a minimal Node ServerResponse-like object that captures the output
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let statusCode = 200;
    const responseHeaders = new Headers();
    const res = {
      statusCode: 200,
      _headers: {} as Record<string, string>,
      setHeader(name: string, value: string) {
        this._headers[name.toLowerCase()] = value;
        responseHeaders.set(name, value);
      },
      getHeader(name: string) {
        return this._headers[name.toLowerCase()];
      },
      removeHeader(name: string) {
        delete this._headers[name.toLowerCase()];
        responseHeaders.delete(name);
      },
      writeHead(code: number, headers?: Record<string, string>) {
        statusCode = code;
        this.statusCode = code;
        if (headers) {
          for (const [k, v] of Object.entries(headers)) {
            this.setHeader(k, v);
          }
        }
      },
      write(chunk: string | Uint8Array) {
        const data = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
        chunks.push(data);
        return true;
      },
      end(chunk?: string | Uint8Array) {
        if (chunk) this.write(chunk);
        statusCode = this.statusCode;
        const body = chunks.length
          ? new Blob(chunks).stream()
          : null;
        resolve(new Response(body, { status: statusCode, headers: responseHeaders }));
      },
      // Express calls these:
      on() { return this; },
      once() { return this; },
      emit() { return false; },
    };

    // Feed the request body into Express
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app(req as any, res as any);

    request.text().then((bodyText) => {
      if (bodyText) {
        bodyStream.push(bodyText);
      }
      bodyStream.push(null);
    });
  });
}

// ── Worker default export ─────────────────────────────────────────────────────

let cachedApp: express.Express | null = null;
let cachedEnvHash = "";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Inject the D1 client for this request
    setPrisma(createD1Client(env.DB));

    const url = new URL(request.url);

    // Webhook endpoint — handle directly without Express
    if (
      url.pathname === "/api/github/webhooks" ||
      url.pathname === "/api/github/hooks"
    ) {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      return handleWebhook(request, env);
    }

    // All other routes go through the Express app (API + auth)
    const envHash = env.APP_ID + (env.CORS_ORIGINS ?? "");
    if (!cachedApp || cachedEnvHash !== envHash) {
      cachedApp = buildExpressApp(env);
      cachedEnvHash = envHash;
    }

    return expressToFetchResponse(cachedApp, request);
  },
};
