import { Request, Response, NextFunction } from "express";
import { RetryOctokit } from "./octokit";

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

export interface AuthRequest extends Request {
  user?: GitHubUser;
  /** The raw Bearer token supplied by the caller. */
  token?: string;
}

// Simple in-memory token → user cache to avoid hitting the GitHub API on
// every authenticated request.  Entries expire after 5 minutes.
interface CacheEntry {
  user: GitHubUser;
  expiresAt: number;
}
const tokenCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1_000;

/**
 * Verify the GitHub Bearer token in the Authorization header.
 * On success, attaches `req.user` and `req.token`.
 */
export async function authenticateUser(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authorization header required (Bearer <github_token>)" });
    return;
  }

  const token = authHeader.slice(7);

  // Serve from cache first.
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    req.user = cached.user;
    req.token = token;
    next();
    return;
  }

  // Validate against GitHub API.
  try {
    const octokit = new RetryOctokit({ auth: token });
    const { data } = await octokit.users.getAuthenticated();

    const user: GitHubUser = {
      id: data.id,
      login: data.login,
      name: data.name ?? null,
      email: data.email ?? null,
    };

    tokenCache.set(token, { user, expiresAt: Date.now() + CACHE_TTL_MS });

    // Prune stale entries once the cache gets large.
    if (tokenCache.size > 500) {
      const now = Date.now();
      for (const [k, v] of tokenCache) {
        if (v.expiresAt < now) tokenCache.delete(k);
      }
    }

    req.user = user;
    req.token = token;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired GitHub token" });
  }
}
