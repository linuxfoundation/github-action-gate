/* global ACTION_GATE_API_URL */
"use strict";

// ── Configuration ─────────────────────────────────────────────────────────────

const API_BASE =
  (typeof window !== "undefined" && window.ACTION_GATE_API_URL) || window.location.origin;

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  page: 1,
  perPage: 30,
  totalPages: 1,
  sortCol: "expiresAt",
  sortDir: "asc", // "asc" | "desc"
  filters: {
    active_only: "true",
    owner: "",
    repo: "",
    workflow: "",
    voucher: "",
    org: "",
  },
};

// Keys of runs selected for batch vouching: "${owner}/${repo}::${workflowPath}"
const selectedRunKeys = new Set();

// ── DOM references ────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const els = {
  loading: $("loading"),
  errorMsg: $("error-msg"),
  wrapper: $("table-wrapper"),
  tbody: $("attestations-body"),
  count: $("result-count"),
  pagination: $("pagination"),
  pageInfo: $("page-info"),
  btnPrev: $("btn-prev"),
  btnNext: $("btn-next"),
  filterStatus: $("filter-status"),
  filterOrg: $("filter-org"),
  filterRepo: $("filter-repo"),
  filterWorkflow: $("filter-workflow"),
  filterVoucher: $("filter-voucher"),
  btnSearch: $("btn-search"),
  btnReset: $("btn-reset"),
};

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch(path) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function expiryStatus(expiresAt, revokedAt) {
  if (revokedAt) return { label: "Revoked", cls: "badge-revoked" };
  const now = Date.now();
  const exp = new Date(expiresAt).getTime();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  if (exp < now) return { label: "Expired", cls: "badge-expired" };
  if (exp - now < thirtyDays) return { label: "Expiring soon", cls: "badge-expiring" };
  return { label: "Active", cls: "badge-active" };
}

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderRow(a) {
  const repo = a.repository
    ? `${escapeHtml(a.repository.owner)}/${escapeHtml(a.repository.name)}`
    : "—";
  const workflowJob = a.jobName
    ? `${escapeHtml(a.workflowPath)}<br/><span class="text-muted mono">job: ${escapeHtml(a.jobName)}</span>`
    : `<span class="mono">${escapeHtml(a.workflowPath)}</span>`;
  const tier =
    a.tier === "ORGANIZATION"
      ? `<span class="badge badge-org">org</span>`
      : `<span class="badge badge-user">user</span>`;
  const voucher = `<a href="https://github.com/${escapeHtml(a.voucherGithubLogin)}" target="_blank" rel="noopener">@${escapeHtml(a.voucherGithubLogin)}</a>`;
  const affil = escapeHtml(a.voucherOrgAffiliation) || '<span class="text-muted">—</span>';
  const org = a.orgGithubLogin
    ? `<a href="https://github.com/${escapeHtml(a.orgGithubLogin)}" target="_blank" rel="noopener">@${escapeHtml(a.orgGithubLogin)}</a>`
    : '<span class="text-muted">—</span>';
  const notes = a.notes
    ? `<span title="${escapeHtml(a.notes)}">${escapeHtml(a.notes.length > 60 ? a.notes.slice(0, 57) + "…" : a.notes)}</span>`
    : '<span class="text-muted">—</span>';
  const expiry = formatDate(a.expiresAt);
  const { label, cls } = expiryStatus(a.expiresAt, a.revokedAt);
  const statusBadge = `<span class="badge ${cls}">${label}</span>`;

  return `<tr>
    <td class="mono">${repo}</td>
    <td>${workflowJob}</td>
    <td>${tier}</td>
    <td>${voucher}</td>
    <td>${affil}</td>
    <td>${org}</td>
    <td>${notes}</td>
    <td>${expiry}</td>
    <td>${statusBadge}</td>
  </tr>`;
}

function renderTable(data) {
  if (!data.attestations || data.attestations.length === 0) {
    els.tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--color-muted);padding:32px;">No attestations found matching these filters.</td></tr>`;
  } else {
    els.tbody.innerHTML = data.attestations.map(renderRow).join("");
  }

  const total = data.total ?? 0;
  els.count.textContent = `${total.toLocaleString()} result${total !== 1 ? "s" : ""}`;

  state.totalPages = Math.max(1, Math.ceil(total / state.perPage));
  els.pageInfo.textContent = `Page ${state.page} of ${state.totalPages}`;
  els.btnPrev.disabled = state.page <= 1;
  els.btnNext.disabled = state.page >= state.totalPages;

  els.loading.hidden = true;
  els.errorMsg.hidden = true;
  els.wrapper.hidden = false;
  els.pagination.hidden = state.totalPages <= 1;
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function loadSummary() {
  try {
    const data = await apiFetch("/api/v1/summary");
    $("stat-repos").querySelector(".stat-value").textContent = (
      data.totalRepos ?? 0
    ).toLocaleString();
    $("stat-active").querySelector(".stat-value").textContent = (
      data.activeAttestations ?? 0
    ).toLocaleString();
    $("stat-expiring").querySelector(".stat-value").textContent = (
      data.expiringSoon ?? 0
    ).toLocaleString();
    $("stat-total").querySelector(".stat-value").textContent = (
      data.totalAttestations ?? 0
    ).toLocaleString();
  } catch {
    // Non-fatal — summary cards stay at "—".
  }
}

async function loadAttestations() {
  els.loading.hidden = false;
  els.wrapper.hidden = true;
  els.pagination.hidden = true;
  els.errorMsg.hidden = true;

  const params = new URLSearchParams({ page: state.page, per_page: state.perPage });

  if (state.filters.active_only === "true") params.set("active_only", "true");
  if (state.filters.owner) params.set("owner", state.filters.owner);
  if (state.filters.repo) params.set("repo", state.filters.repo);
  if (state.filters.workflow) params.set("workflow", state.filters.workflow);
  if (state.filters.voucher) params.set("voucher", state.filters.voucher);
  if (state.filters.org) {
    // org can match either verified org login OR self-reported affiliation.
    // The API supports filtering by org login; affiliation is client-side filtered below.
    params.set("org", state.filters.org);
  }

  // Apply client-side sort preference to URL sort hint (future API feature).
  // For now we sort the returned page client-side.
  try {
    const data = await apiFetch(`/api/v1/attestations?${params}`);

    // Client-side sort on the current page.
    if (data.attestations && state.sortCol) {
      data.attestations.sort((a, b) => {
        let va = getColValue(a, state.sortCol);
        let vb = getColValue(b, state.sortCol);
        if (va < vb) return state.sortDir === "asc" ? -1 : 1;
        if (va > vb) return state.sortDir === "asc" ? 1 : -1;
        return 0;
      });
    }

    renderTable(data);
  } catch (err) {
    els.loading.hidden = true;
    els.errorMsg.textContent = `Failed to load attestations: ${err.message}`;
    els.errorMsg.hidden = false;
  }
}

function getColValue(a, col) {
  switch (col) {
    case "repository":
      return a.repository ? `${a.repository.owner}/${a.repository.name}` : "";
    case "workflowPath":
      return `${a.workflowPath}/${a.jobName ?? ""}`;
    case "voucherGithubLogin":
      return a.voucherGithubLogin ?? "";
    case "voucherOrgAffiliation":
      return a.voucherOrgAffiliation ?? "";
    case "orgGithubLogin":
      return a.orgGithubLogin ?? "";
    case "expiresAt":
      return a.expiresAt ?? "";
    default:
      return "";
  }
}

// ── Sorting ───────────────────────────────────────────────────────────────────

function initSorting() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (state.sortCol === col) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortCol = col;
        state.sortDir = "asc";
      }
      // Update sort indicator classes.
      document.querySelectorAll("th.sortable").forEach((t) => {
        t.classList.remove("sort-asc", "sort-desc");
      });
      th.classList.add(`sort-${state.sortDir}`);
      state.page = 1;
      loadAttestations();
    });
  });
}

// ── Events ────────────────────────────────────────────────────────────────────

function applyFilters() {
  const repoInput = els.filterRepo.value.trim();
  const [ownerPart, repoPart] = repoInput.includes("/") ? repoInput.split("/", 2) : ["", repoInput];

  state.filters.active_only = els.filterStatus.value === "active" ? "true" : "";
  state.filters.owner = ownerPart || "";
  state.filters.repo = repoPart || "";
  state.filters.workflow = els.filterWorkflow.value.trim();
  state.filters.voucher = els.filterVoucher.value.trim();
  state.filters.org = els.filterOrg.value.trim();
  state.page = 1;
  loadAttestations();
}

function resetFilters() {
  els.filterStatus.value = "active";
  els.filterOrg.value = "";
  els.filterRepo.value = "";
  els.filterWorkflow.value = "";
  els.filterVoucher.value = "";
  state.filters = { active_only: "true", owner: "", repo: "", workflow: "", voucher: "", org: "" };
  state.page = 1;
  loadAttestations();
}

els.btnSearch.addEventListener("click", applyFilters);
els.btnReset.addEventListener("click", resetFilters);
[els.filterOrg, els.filterRepo, els.filterWorkflow, els.filterVoucher].forEach((inp) => {
  inp.addEventListener("keypress", (e) => {
    if (e.key === "Enter") applyFilters();
  });
});
els.filterStatus.addEventListener("change", applyFilters);
els.btnPrev.addEventListener("click", () => {
  state.page--;
  loadAttestations();
});
els.btnNext.addEventListener("click", () => {
  state.page++;
  loadAttestations();
});

// ── Auth ──────────────────────────────────────────────────────────────────────

const AUTH_KEY = "ag_token";

function getAuthToken() {
  return sessionStorage.getItem(AUTH_KEY);
}
function setAuthToken(t) {
  sessionStorage.setItem(AUTH_KEY, t);
}
function clearAuthToken() {
  sessionStorage.removeItem(AUTH_KEY);
}

async function initAuth() {
  // Pick up the token that GitHub OAuth drops into the URL fragment, then
  // clean the URL so the token does not remain visible or in browser history.
  const hash = window.location.hash;
  if (hash.startsWith("#token=")) {
    const token = decodeURIComponent(hash.slice(7));
    setAuthToken(token);
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  const token = getAuthToken();
  if (token) {
    await loadCurrentUser(token);
  } else {
    showLoggedOut();
  }
}

async function loadCurrentUser(token) {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      clearAuthToken();
      showLoggedOut();
      return;
    }
    const user = await res.json();
    showLoggedIn(user);
  } catch {
    showLoggedOut();
  }
}

function showLoggedIn(user) {
  $("btn-login").hidden = true;
  $("user-info").hidden = false;
  $("user-avatar").src = user.avatar_url ?? "";
  $("user-avatar").alt = `@${escapeHtml(user.login)}`;
  $("user-login").textContent = `@${user.login}`;
  $("btn-vouch").hidden = false;
  loadUserOrgs(getAuthToken());
}

function showLoggedOut() {
  $("btn-login").hidden = false;
  $("user-info").hidden = true;
  $("btn-vouch").hidden = true;
  cachedOrgs = [];
  $("orgs-error-hint").hidden = true;
  populateOrgSelect();
}

// ── GitHub org fetching ───────────────────────────────────────────────────

let cachedOrgs = [];

async function loadUserOrgs(token) {
  if (!token) return;
  $("orgs-loading-hint").hidden = false;
  $("orgs-error-hint").hidden = true;
  try {
    const res = await fetch("https://api.github.com/user/orgs?per_page=100", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    const scopes = res.headers.get("X-OAuth-Scopes") ?? "(none)";
    console.debug("[ActionGate] /user/orgs status:", res.status, "| OAuth scopes:", scopes);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.warn("[ActionGate] /user/orgs error:", body);
      showOrgLoadError();
      return;
    }
    const orgs = await res.json();
    console.debug(
      "[ActionGate] orgs received:",
      orgs.map((o) => o.login)
    );
    cachedOrgs = orgs;
    if (cachedOrgs.length === 0) {
      console.warn(
        "[ActionGate] No orgs returned. Token may lack read:org scope or require SAML SSO authorization."
      );
      showOrgLoadError(
        "No organizations found for your account. Your token may need read:org scope or SAML SSO re-authorization."
      );
    } else {
      populateOrgSelect();
    }
  } catch (err) {
    console.warn("[ActionGate] Failed to fetch orgs:", err);
    showOrgLoadError();
  } finally {
    $("orgs-loading-hint").hidden = true;
  }
}

function showOrgLoadError(msg) {
  const hint = $("orgs-error-hint");
  if (msg) {
    // Replace only the text node before the Retry button, preserving the button.
    hint.firstChild.textContent = msg + " ";
  }
  hint.hidden = false;
  // Fall back to manual input automatically.
  populateOrgSelect();
  $("f-org-select").value = "__other__";
  $("org-login-custom-row").hidden = false;
}

function populateOrgSelect() {
  const sel = $("f-org-select");
  const prev = sel.value;
  sel.innerHTML = `<option value="">Select an organization…</option>`;
  cachedOrgs.forEach((org) => {
    const opt = document.createElement("option");
    opt.value = org.login;
    opt.textContent = org.login;
    sel.appendChild(opt);
  });
  const other = document.createElement("option");
  other.value = "__other__";
  other.textContent = "Other (enter manually)…";
  sel.appendChild(other);
  // Restore previous selection if it's still valid.
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

$("btn-login").addEventListener("click", () => {
  window.location.href = `${API_BASE}/auth/github`;
});

$("btn-logout").addEventListener("click", () => {
  clearAuthToken();
  showLoggedOut();
});

// ── Vouch modal ───────────────────────────────────────────────────────────────

function openModal() {
  $("vouch-modal").hidden = false;
  $("f-repo").focus();
  document.body.style.overflow = "hidden";
}

function closeModal() {
  $("vouch-modal").hidden = true;
  document.body.style.overflow = "";
  $("vouch-form").reset();
  $("org-login-row").hidden = true;
  $("org-login-custom-row").hidden = true;
  $("form-error").hidden = true;
  $("form-submit").disabled = false;
  $("form-submit").textContent = "Submit attestation";
}

$("btn-vouch").addEventListener("click", openModal);
$("modal-close").addEventListener("click", closeModal);
$("form-cancel").addEventListener("click", closeModal);

$("vouch-modal").addEventListener("click", (e) => {
  if (e.target === $("vouch-modal")) closeModal();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("vouch-modal").hidden) closeModal();
});

$("f-tier").addEventListener("change", () => {
  const isOrg = $("f-tier").value === "organization";
  $("org-login-row").hidden = !isOrg;
  if (!isOrg) $("org-login-custom-row").hidden = true;
  if (isOrg) $("f-org-select").focus();
});

document.addEventListener("DOMContentLoaded", () => {
  const retryBtn = $("btn-retry-orgs");
  if (retryBtn) {
    retryBtn.addEventListener("click", () => {
      $("orgs-error-hint").hidden = true;
      $("org-login-custom-row").hidden = true;
      loadUserOrgs(getAuthToken());
    });
  }
});

$("f-org-select").addEventListener("change", () => {
  const isOther = $("f-org-select").value === "__other__";
  $("org-login-custom-row").hidden = !isOther;
  if (isOther) $("f-org-login").focus();
});

$("vouch-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("form-error").hidden = true;

  const token = getAuthToken();
  if (!token) {
    $("form-error").textContent = "You must be logged in to create attestations.";
    $("form-error").hidden = false;
    return;
  }

  const repo = $("f-repo").value.trim();
  const workflowPath = $("f-workflow").value.trim();

  if (!repo || !workflowPath) {
    $("form-error").textContent = "Repository and workflow path are required.";
    $("form-error").hidden = false;
    return;
  }

  const tier = $("f-tier").value;
  const orgSelectVal = $("f-org-select").value;
  const orgLogin =
    orgSelectVal === "__other__" ? $("f-org-login").value.trim() || null : orgSelectVal || null;

  if (tier === "organization" && !orgLogin) {
    $("form-error").textContent =
      orgSelectVal === "__other__"
        ? "Please enter the org login manually."
        : "Please select a GitHub organization.";
    $("form-error").hidden = false;
    return;
  }

  const jobName = $("f-job").value.trim() || null;
  const affil = $("f-affil").value.trim() || null;
  const notes = $("f-notes").value.trim() || null;
  const expiryRaw = parseInt($("f-expiry").value, 10);
  const expiryDays = Number.isFinite(expiryRaw) && expiryRaw > 0 ? expiryRaw : undefined;

  $("form-submit").disabled = true;
  $("form-submit").textContent = "Submitting\u2026";

  const body = { repository: repo, workflow_path: workflowPath, tier };
  if (jobName) body.job_name = jobName;
  if (orgLogin) body.org_github_login = orgLogin;
  if (affil) body.org_affiliation = affil;
  if (notes) body.notes = notes;
  if (expiryDays) body.expiry_days = expiryDays;

  try {
    const res = await fetch(`${API_BASE}/api/v1/attestations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const msg = data.error || `HTTP ${res.status}`;
      if (res.status === 401) {
        clearAuthToken();
        showLoggedOut();
        closeModal();
        alert("Your session has expired \u2014 please log in again.");
      } else if (res.status === 409) {
        closeModal();
        loadRecentRuns();
        loadAttestations();
      } else {
        $("form-error").textContent = msg;
        $("form-error").hidden = false;
        $("form-submit").disabled = false;
        $("form-submit").textContent = "Submit attestation";
      }
      return;
    }

    closeModal();
    loadSummary();
    loadAttestations();
  } catch (err) {
    $("form-error").textContent = `Request failed: ${err.message}`;
    $("form-error").hidden = false;
    $("form-submit").disabled = false;
    $("form-submit").textContent = "Submit attestation";
  }
});

// ── Recent Workflow Runs ───────────────────────────────────────────────────────

function runConclusionBadge(status, conclusion) {
  if (status !== "completed") {
    return `<span class="badge badge-in-progress">In progress</span>`;
  }
  const map = {
    success: ["badge-success", "Success"],
    failure: ["badge-failure", "Failure"],
    cancelled: ["badge-cancelled", "Cancelled"],
    skipped: ["badge-skipped", "Skipped"],
    timed_out: ["badge-failure", "Timed out"],
    action_required: ["badge-warning", "Action required"],
  };
  const [cls, label] = map[conclusion] ?? ["badge-cancelled", conclusion ?? "Unknown"];
  return `<span class="badge ${cls}">${label}</span>`;
}

function timeAgo(iso) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function renderRunRow(run) {
  const repo = run.repository
    ? `<a href="https://github.com/${escapeHtml(run.repository.owner)}/${escapeHtml(run.repository.name)}" target="_blank" rel="noopener" class="mono">${escapeHtml(run.repository.owner)}/${escapeHtml(run.repository.name)}</a>`
    : "—";
  // Only allow safe HTTPS URLs as the workflow run link to guard against
  // javascript: URI injection — htmlUrl comes from the database via GitHub API.
  const safeHtmlUrl = run.htmlUrl && /^https:\/\//.test(run.htmlUrl) ? run.htmlUrl : null;
  const workflowLink = safeHtmlUrl
    ? `<a href="${escapeHtml(safeHtmlUrl)}" target="_blank" rel="noopener" class="mono">${escapeHtml(run.workflowPath)}</a>`
    : `<span class="mono">${escapeHtml(run.workflowPath)}</span>`;
  const branch = run.headBranch
    ? `<span class="mono">${escapeHtml(run.headBranch)}</span>`
    : '<span class="text-muted">—</span>';
  const event = `<span class="badge-event">${escapeHtml(run.event)}</span>`;
  const status = runConclusionBadge(run.status, run.conclusion);
  const started = `<span title="${escapeHtml(run.runStartedAt ?? run.createdAt)}">${timeAgo(run.runStartedAt ?? run.createdAt)}</span>`;

  const repoFull = run.repository ? `${run.repository.owner}/${run.repository.name}` : "";
  const vouchBtn =
    repoFull && !run.isAttested
      ? `<button class="btn btn-primary btn-sm btn-vouch-run"
         data-repo="${escapeHtml(repoFull)}"
         data-workflow="${escapeHtml(run.workflowPath)}"
         title="Vouch for this workflow">Vouch</button>`
      : repoFull
        ? `<span class="badge badge-success" title="Active attestation exists">✓ Vouched</span>`
        : "";

  const runKey = repoFull ? `${escapeHtml(repoFull)}::${escapeHtml(run.workflowPath)}` : "";
  const checkCell =
    repoFull && !run.isAttested
      ? `<td><input type="checkbox" class="run-select" data-key="${runKey}"
         data-repo="${escapeHtml(repoFull)}" data-workflow="${escapeHtml(run.workflowPath)}"
         title="Select for batch vouch"${selectedRunKeys.has(runKey) ? " checked" : ""}></td>`
      : "<td></td>";

  return `<tr>
    ${checkCell}
    <td>${repo}</td>
    <td>${workflowLink}</td>
    <td>${branch}</td>
    <td>${event}</td>
    <td>${status}</td>
    <td>${started}</td>
    <td style="text-align:right">${vouchBtn}</td>
  </tr>`;
}

async function loadRecentRuns() {
  $("runs-loading").hidden = false;
  $("runs-wrapper").hidden = true;
  $("runs-error").hidden = true;

  try {
    const data = await apiFetch("/api/v1/runs/recent?limit=10");
    const runs = data.runs ?? [];
    // Filter out runs that are already attested at the workflow level.
    const unvouched = runs.filter((r) => !r.isAttested);
    $("runs-count").textContent =
      unvouched.length > 0
        ? `${unvouched.length} unvouched run${unvouched.length !== 1 ? "s" : ""}`
        : "";

    if (unvouched.length === 0) {
      $("runs-body").innerHTML =
        `<tr><td colspan="8" style="text-align:center;color:var(--color-muted);padding:24px;">All recent workflow runs have active attestations — nothing to vouch for.</td></tr>`;
      const selectAll = $("runs-select-all");
      if (selectAll) selectAll.checked = false;
    } else {
      $("runs-body").innerHTML = unvouched.map(renderRunRow).join("");
      // Wire up per-row checkboxes
      document.querySelectorAll(".run-select").forEach((cb) => {
        cb.addEventListener("change", (e) => {
          const key = e.target.dataset.key;
          if (e.target.checked) {
            selectedRunKeys.add(key);
          } else {
            selectedRunKeys.delete(key);
            const selectAll = $("runs-select-all");
            if (selectAll) selectAll.checked = false;
          }
          updateVouchSelectedBtn();
        });
      });
      // Wire up select-all
      const selectAll = $("runs-select-all");
      if (selectAll) {
        selectAll.checked = false;
        selectAll.addEventListener("change", (e) => {
          document.querySelectorAll(".run-select").forEach((cb) => {
            cb.checked = e.target.checked;
            const key = cb.dataset.key;
            if (e.target.checked) selectedRunKeys.add(key);
            else selectedRunKeys.delete(key);
          });
          updateVouchSelectedBtn();
        });
      }
    }

    $("runs-loading").hidden = true;
    $("runs-wrapper").hidden = false;
  } catch (err) {
    $("runs-loading").hidden = true;
    $("runs-error").textContent = `Failed to load runs: ${err.message}`;
    $("runs-error").hidden = false;
  }
}

// ── Batch vouch helpers ───────────────────────────────────────────────────────

function updateVouchSelectedBtn() {
  const btn = $("btn-vouch-selected");
  if (!btn) return;
  const count = selectedRunKeys.size;
  btn.hidden = count === 0;
  btn.textContent = `Vouch selected (${count})`;
}

async function vouchSelected() {
  const token = getAuthToken();
  if (!token) {
    alert("Please log in with GitHub before creating attestations.");
    return;
  }
  if (selectedRunKeys.size === 0) return;

  // Collect the checked row data attributes for the API call
  const items = [];
  document.querySelectorAll(".run-select:checked").forEach((cb) => {
    items.push({ repository: cb.dataset.repo, workflow_path: cb.dataset.workflow });
  });

  const btn = $("btn-vouch-selected");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Vouching…";

  try {
    const res = await fetch(`${API_BASE}/api/v1/attestations/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ attestations: items }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok && res.status !== 207) {
      alert(`Batch vouch failed: ${data.error ?? res.statusText}`);
      return;
    }

    const { summary } = data;
    selectedRunKeys.clear();
    updateVouchSelectedBtn();
    const selectAll = $("runs-select-all");
    if (selectAll) selectAll.checked = false;

    // Refresh all relevant sections
    await Promise.all([loadRecentRuns(), loadAttestations(), loadSummary()]);

    if (summary) {
      const parts = [];
      if (summary.created) parts.push(`${summary.created} created`);
      if (summary.skipped) parts.push(`${summary.skipped} skipped (already attested)`);
      if (summary.errors) parts.push(`${summary.errors} failed`);
      if (parts.length) alert(`Batch vouch complete: ${parts.join(", ")}.`);
    }
  } catch (err) {
    alert(`Batch vouch error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

$("btn-vouch-selected").addEventListener("click", vouchSelected);

// Vouch buttons inside the runs table — pre-fill and open the modal.
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".btn-vouch-run");
  if (!btn) return;
  const token = getAuthToken();
  if (!token) {
    alert("Please log in with GitHub before creating an attestation.");
    return;
  }
  $("f-repo").value = btn.dataset.repo ?? "";
  $("f-workflow").value = btn.dataset.workflow ?? "";
  openModal();
});

$("btn-refresh-runs").addEventListener("click", loadRecentRuns);

// ── Init ──────────────────────────────────────────────────────────────────────

initSorting();
loadSummary();
loadRecentRuns();
loadAttestations();
initAuth();
