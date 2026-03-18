// SPDX-FileCopyrightText: 2026 The Linux Foundation
//
// SPDX-License-Identifier: Apache-2.0

/* global ACTION_GATE_API_URL */
"use strict";

const API_BASE =
  (typeof window !== "undefined" && window.ACTION_GATE_API_URL) || window.location.origin;

function $(id) { return document.getElementById(id); }

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ── State ─────────────────────────────────────────────────────────────────────

const state = { page: 1, perPage: 30, total: 0, totalPages: 1 };

// ── API helper ────────────────────────────────────────────────────────────────

async function apiFetch(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderRepos(repos) {
  const tbody = $("repos-body");
  if (!repos.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No repositories found.</td></tr>`;
    return;
  }

  tbody.innerHTML = repos
    .map((r) => {
      const fullName = `${escapeHtml(r.owner)}/${escapeHtml(r.name)}`;
      const ghLink = `https://github.com/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`;
      const activeCount = r._count?.attestations ?? 0;
      const mode = r.mode === "BLOCK" ? "Block" : r.mode === "WARN" ? "Warn" : escapeHtml(r.mode);
      const modeClass = r.mode === "BLOCK" ? "badge badge-danger" : "badge badge-warn";
      const added = new Date(r.createdAt).toLocaleDateString();
      return `<tr>
        <td><a href="${escapeHtml(ghLink)}" target="_blank" rel="noopener">${fullName}</a></td>
        <td><span class="${modeClass}">${mode}</span></td>
        <td>${activeCount}</td>
        <td>${r.expiryDays ?? "—"}</td>
        <td>${added}</td>
      </tr>`;
    })
    .join("");
}

function updatePagination() {
  $("page-info").textContent = `Page ${state.page} of ${state.totalPages}`;
  $("btn-prev").disabled = state.page <= 1;
  $("btn-next").disabled = state.page >= state.totalPages;
  $("pagination").hidden = state.totalPages <= 1;
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function loadRepos() {
  $("loading").hidden = false;
  $("error-msg").hidden = true;
  $("table-wrapper").hidden = true;

  try {
    const data = await apiFetch(
      `/api/v1/repositories?page=${state.page}&per_page=${state.perPage}`
    );
    state.total = data.total ?? 0;
    state.totalPages = Math.max(1, Math.ceil(state.total / state.perPage));

    renderRepos(data.repositories ?? []);
    updatePagination();

    $("loading").hidden = true;
    $("table-wrapper").hidden = false;
  } catch (err) {
    $("loading").hidden = true;
    $("error-msg").textContent = `Failed to load repositories: ${err.message}`;
    $("error-msg").hidden = false;
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

const AUTH_KEY = "ag_token";

function getAuthToken()  { return sessionStorage.getItem(AUTH_KEY); }
function setAuthToken(t) { sessionStorage.setItem(AUTH_KEY, t); }
function clearAuthToken() { sessionStorage.removeItem(AUTH_KEY); }

async function initAuth() {
  const hash = window.location.hash;
  if (hash.startsWith("#token=")) {
    const token = decodeURIComponent(hash.slice(7));
    setAuthToken(token);
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  const token = getAuthToken();
  if (!token) { showLoggedOut(); return; }

  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) { clearAuthToken(); showLoggedOut(); return; }
    const user = await res.json();
    showLoggedIn(user);
  } catch { showLoggedOut(); }
}

function showLoggedIn(user) {
  $("btn-login").hidden = true;
  $("user-info").hidden = false;
  $("user-avatar").src = user.avatar_url ?? "";
  $("user-avatar").alt = `@${escapeHtml(user.login)}`;
  $("user-login").textContent = `@${user.login}`;
}

function showLoggedOut() {
  $("btn-login").hidden = false;
  $("user-info").hidden = true;
}

// ── Events ────────────────────────────────────────────────────────────────────

$("btn-prev").addEventListener("click", () => {
  if (state.page > 1) { state.page--; loadRepos(); }
});
$("btn-next").addEventListener("click", () => {
  if (state.page < state.totalPages) { state.page++; loadRepos(); }
});
$("btn-login").addEventListener("click", () => {
  window.location.href = `${API_BASE}/auth/github`;
});
$("btn-logout").addEventListener("click", () => {
  clearAuthToken();
  showLoggedOut();
});

// ── Init ──────────────────────────────────────────────────────────────────────

initAuth();
loadRepos();

// ── Deploy SHA link (same pattern as main dashboard) ──────────────────────────

(function deployShaLink() {
  const el = $("deploy-sha");
  if (!el) return;
  const sha = el.textContent.trim();
  if (!sha || sha === "__GIT_SHA__") {
    el.hidden = true;
    return;
  }
  const link = document.createElement("a");
  link.href = `https://github.com/__GITHUB_REPO__/commit/${encodeURIComponent(sha)}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = sha;
  link.className = "deploy-sha";
  el.replaceWith(link);
})();
