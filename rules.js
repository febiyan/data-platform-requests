// The request rules, in the browser. Mirrors gitops/scripts/forms.py (--parse),
// gitops/scripts/request.py, the team and workspace schemas and
// gitops/scripts/approval.py. Those stay the authority: the bot checks every
// request again, so a request this page lets through can still be refused.

const ENVIRONMENTS = ["dev", "stg", "prd"];
const PLATFORM_NAMES = { databricks: "Databricks", powerbi: "Power BI" };
const VARIANT_NAMES = { serverless: "Analyse and report", classic: "Build data pipelines" };
const COST_CENTER = /^[A-Z][0-9]{4}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const GROUP_ROLES = { owner: "Owner", "workspace-contributor": "Contributor", "workspace-observer": "Observer" };
const PLATFORM_IDS = { databricks: "DBX", powerbi: "PBI" };

export function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/^-+|-+$/g, "");
}

function optionValue(field, label) {
  const found = (field.options || []).find((o) => o.label === label);
  return found ? found.value : label;
}

// What forms.py --parse, then request.py normalize(), make of the answers.
export function buildRequest(form, values) {
  const request = { action: form.action };
  for (const field of form.fields) {
    const raw = values[field.id];
    if (field.id === "reason") continue;
    if (field.type === "checkboxes") {
      const picked = (raw || []).map((label) => optionValue(field, label));
      if (picked.length) request[field.id] = picked;
    } else if (field.type === "dropdown") {
      if (!raw) continue;
      const value = optionValue(field, raw);
      if (value !== null || field.id === "region") request[field.id] = value;
    } else if (field.id === "approvers") {
      const lines = String(raw || "").split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length) request.approvers = lines;
    } else if (String(raw || "").trim()) {
      request[field.id] = String(raw).trim();
    }
  }
  return request;
}

export function decide(request, policy) {
  for (const rule of policy) {
    if (rule.action !== request.action) continue;
    const matches = Object.entries(rule.when).every(([field, allowed]) => allowed.includes(request[field] ?? null));
    if (matches) return { auto: true, merge: rule.merge, reason: rule.reason };
  }
  return { auto: false, merge: false, reason: "This kind of request needs a person: the approvers of the teams involved review it." };
}

function index(state) {
  const teams = new Map(state.teams.map((t) => [t.id, t]));
  const workspaces = new Map(state.workspaces.map((w) => [w.id, w]));
  const ownerOf = (ws) => state.teams.find((t) => t.workspaces.some((e) => e.workspace === ws && e.role === "owner"));
  return { teams, workspaces, ownerOf };
}

function environmentsFor(platform, wanted) {
  return ENVIRONMENTS.filter((e) => (wanted || []).includes(e) && !(platform === "powerbi" && e === "stg"));
}

function groups(platform, ws) {
  return Object.values(GROUP_ROLES).map((role) => `SEC-${PLATFORM_IDS[platform]}-${ws}-${role}`).join(", ");
}

function checkTeamFields(request, result) {
  if ("displayName" in request && request.displayName.length > 100) result.field("displayName", "Give the team a name of up to 100 characters.");
  if ("costCenter" in request && !COST_CENTER.test(request.costCenter)) {
    result.field("costCenter", `Cost center "${request.costCenter}" must be one capital letter and four digits, e.g. K1234.`);
  }
  if ("approvers" in request) {
    const bad = request.approvers.filter((a) => !EMAIL.test(a));
    if (bad.length) result.field("approvers", `Not an email address: ${bad.join(", ")}.`);
    else if (new Set(request.approvers).size !== request.approvers.length) result.field("approvers", "List each approver only once.");
    else if (request.approvers.length < 2) result.field("approvers", "Add at least two approvers, one email per line.");
  }
}

function checkReach(reach, region, result) {
  if (reach === "regional" && region == null) result.field("region", "A regional team needs a business region; pick Not regional only for a global team.");
}

const checks = {
  "create-team"(request, values, s, result) {
    if (!request.displayName) return result.field("displayName", "Give the team a name.");
    const id = slugify(request.displayName);
    if (!id) return result.field("displayName", "The name needs at least one letter or digit.");
    if (s.teams.has(id)) result.field("displayName", `Team ${id} already exists; use Change a team.`);
    checkTeamFields(request, result);
    if (!request.reach) result.field("reach", "Pick a reach.");
    if (!values.region) result.field("region", "Pick a business region, or Not regional for a global team.");
    else checkReach(request.reach, request.region, result);
    if (request.reach === "global" && request.region != null) result.warning("A global team has no business region: the region is dropped.");
    if (!request.costCenter) result.field("costCenter", "Give the cost center, e.g. K1234.");
    if (!request.orgUnitType) result.field("orgUnitType", "Pick an organisation unit type.");
    if (!request.orgUnitName) result.field("orgUnitName", "Give the organisation unit's name.");
    if (!request.approvers) result.field("approvers", "Add at least two approvers, one email per line.");
    result.outcome(`New team **${request.displayName}** with ID [[${id}]]. The ID never changes, even if the name does.`);
    result.outcome("Its approvers approve people joining it in My Access, and changes to it.");
  },

  "change-team"(request, values, s, result) {
    const team = s.teams.get(request.team);
    if (!team) return result.field("team", "Pick a team.");
    checkTeamFields(request, result);
    const reach = request.reach ?? team.reach;
    const region = "region" in request ? request.region : team.region;
    checkReach(reach, region, result);
    const changed = [];
    if ("displayName" in request && request.displayName !== team.displayName) changed.push(`name to **${request.displayName}** (ID stays [[${team.id}]])`);
    if ("reach" in request && request.reach !== team.reach) changed.push(`reach to ${request.reach}`);
    if ("region" in request && request.region !== team.region && reach !== "global") changed.push(`region to ${request.region ?? "none"}`);
    if (reach === "global" && team.region) changed.push("region removed, since the team is global");
    for (const [key, words] of [["costCenter", "cost center"], ["orgUnitType", "organisation unit type"], ["orgUnitName", "organisation unit name"], ["approvers", "approvers"]]) {
      if (key in request) changed.push(`${words} to ${Array.isArray(request[key]) ? request[key].join(", ") : request[key]}`);
    }
    if (!changed.length) return result.error("Nothing changed yet. Edit the fields you want to change; empty fields keep their current value.");
    result.outcome(`Team **${team.displayName}**: ${changed.join("; ")}.`);
  },

  "delete-team"(request, values, s, result) {
    const team = s.teams.get(request.team);
    if (!team) return result.field("team", "Pick a team.");
    const owned = team.workspaces.filter((e) => e.role === "owner").map((e) => e.workspace);
    if (owned.length) return result.field("team", `${team.displayName} owns workspace ${owned.join(", ")}. Remove it, or hand it over, first.`);
    const joined = team.workspaces.map((e) => e.workspace);
    result.outcome(`Team **${team.displayName}** is deleted.`);
    if (joined.length) result.warning(`It also leaves workspace ${joined.join(", ")}.`);
  },

  "create-workspace"(request, values, s, result) {
    const team = s.teams.get(request.team);
    if (!team) result.field("team", "Pick the team that will own the workspace.");
    const platforms = request.platforms || [];
    if (!platforms.length) result.field("platforms", "Tick at least one platform.");
    if (platforms.includes("databricks") && !request.variant) result.field("variant", "Pick a Databricks type.");
    if (!request.environments) result.field("environments", "Tick at least one environment.");
    else if (platforms.includes("powerbi") && !environmentsFor("powerbi", request.environments).length) {
      result.field("environments", "Power BI has dev and prd only: tick dev or prd.");
    }
    const taken = new Set(s.workspaces.keys());
    let number = 1;
    while (taken.has(String(number).padStart(3, "0"))) number++;
    const ws = String(number).padStart(3, "0");
    if (team && platforms.length) result.outcome(`Workspace **${ws}**, owned by **${team.displayName}** (likely number; the bot sets it when the pull request opens).`);
    for (const p of platforms) {
      const envs = environmentsFor(p, request.environments);
      if (!envs.length) continue;
      const kind = p === "databricks" ? (VARIANT_NAMES[request.variant] || "") : `${(request.licenseMode || "pro") === "premium" ? "Premium" : "Pro"} licence`;
      result.outcome(`${PLATFORM_NAMES[p]} ${kind ? `(${kind}) ` : ""}in ${envs.join(", ")}. Groups: [[${groups(p, ws)}]], created by the cyber security pipeline.`);
    }
    if (platforms.includes("powerbi") && (request.environments || []).includes("stg")) result.warning("Power BI has no stg: it is skipped for Power BI.");
    if (request.licenseMode === "premium") result.warning("Power BI Premium needs approval from your director and procurement before merge.");
    if (!platforms.includes("powerbi") && request.licenseMode) result.warning("The Power BI licence is ignored: Power BI is not ticked.");
    if (!platforms.includes("databricks") && request.variant) result.warning("The Databricks type is ignored: Databricks is not ticked.");
  },

  "change-workspace"(request, values, s, result) {
    const ws = s.workspaces.get(request.workspace);
    if (!ws) return result.field("workspace", "Pick a workspace.");
    const current = new Set(Object.keys(PLATFORM_NAMES).filter((p) => p in ws));
    const changes = [];
    if (request.addPlatform) {
      const p = request.addPlatform;
      if (current.has(p)) result.field("addPlatform", `Workspace ${ws.id} already has ${PLATFORM_NAMES[p]}.`);
      else {
        const wanted = request.environments || [...new Set([...current].flatMap((q) => ws[q].environments))];
        const envs = environmentsFor(p, wanted);
        if (p === "databricks" && !request.variant) result.field("variant", "Pick a Databricks type for the added platform.");
        if (!envs.length) result.field("environments", "Pick at least one environment (Power BI: dev or prd).");
        else changes.push(`add ${PLATFORM_NAMES[p]} in ${envs.join(", ")}`);
      }
    }
    if (request.licenseMode && !request.addPlatform) {
      if (!current.has("powerbi")) result.field("licenseMode", "Only Power BI has a licence, and this workspace has no Power BI.");
      else changes.push(`Power BI ${request.licenseMode === "premium" ? "Premium" : "Pro"}`);
    }
    if (request.environments && !request.addPlatform) {
      for (const p of current) {
        if (!environmentsFor(p, request.environments).length) result.field("environments", "Pick at least one environment (Power BI: dev or prd).");
      }
      changes.push(`environments ${ENVIRONMENTS.filter((e) => request.environments.includes(e)).join(", ")}`);
    }
    const roleIn = (teamId) => s.teams.get(teamId)?.workspaces.find((e) => e.workspace === ws.id)?.role;
    let removed = null;
    if (request.removeTeam) {
      const team = s.teams.get(request.removeTeam);
      const role = roleIn(request.removeTeam);
      if (!role) result.field("removeTeam", `${team.displayName} has no role in workspace ${ws.id}.`);
      else if (role === "owner") result.field("removeTeam", `${team.displayName} owns workspace ${ws.id}; hand over ownership first.`);
      else { removed = team.id; changes.push(`${team.displayName} leaves`); }
    }
    if (request.addTeam) {
      const team = s.teams.get(request.addTeam);
      const role = request.addRole || "workspace-contributor";
      if (roleIn(request.addTeam) && removed !== team.id) {
        result.field("addTeam", `${team.displayName} already holds a role in workspace ${ws.id}; remove it first to change the role.`);
      } else changes.push(`${team.displayName} joins as ${GROUP_ROLES[role].toLowerCase()}`);
    } else if (request.addRole) result.warning("The role is ignored: no team to add is picked.");
    if (!changes.length && !result.hasErrors()) return result.error("Nothing to change yet. Fill in only what changes.");
    const owner = s.ownerOf(ws.id);
    if (changes.length) result.outcome(`Workspace **${ws.id}**${owner ? ` (${owner.displayName})` : ""}: ${changes.join("; ")}.`);
    if (request.licenseMode === "premium") result.warning("Power BI Premium needs approval from your director and procurement before merge.");
  },

  "delete-workspace"(request, values, s, result) {
    const ws = s.workspaces.get(request.workspace);
    if (!ws) return result.field("workspace", "Pick a workspace.");
    const teams = [...s.teams.values()].filter((t) => t.workspaces.some((e) => e.workspace === ws.id)).map((t) => t.displayName);
    result.outcome(`Workspace **${ws.id}** is removed on every platform and in every environment once merged.`);
    if (teams.length) result.outcome(`It is taken off ${teams.join(", ")}.`);
    result.outcome("Catalogs and data are never deleted.");
  },
};

// Field errors, general errors, warnings and the plain-language outcome of one request.
export function check(form, values, state) {
  const fieldErrors = {};
  const errors = [];
  const warnings = [];
  const outcome = [];
  const result = {
    field: (id, message) => { fieldErrors[id] ??= message; },
    error: (message) => errors.push(message),
    warning: (message) => warnings.push(message),
    outcome: (text) => outcome.push(text),
    hasErrors: () => Object.keys(fieldErrors).length + errors.length > 0,
  };
  const request = buildRequest(form, values);
  for (const field of form.fields) {
    const raw = values[field.id];
    const empty = Array.isArray(raw) ? !raw.length : !String(raw || "").trim();
    if (field.required && empty) result.field(field.id, field.type === "checkboxes" ? "Tick at least one." : "Required.");
  }
  checks[form.action](request, values, index(state), result);
  return { request, fieldErrors, errors, warnings, outcome, ok: !result.hasErrors() };
}

// A new-issue link that opens the issue form with the answers filled in.
// GitHub fills each field from the query parameter named after its id.
export function issueLink(repository, form, values, title) {
  const query = new URLSearchParams({ template: form.template, title });
  for (const field of form.fields) {
    const raw = values[field.id];
    if (Array.isArray(raw)) { if (raw.length) query.set(field.id, raw.join(",")); }
    else if (String(raw || "").trim()) query.set(field.id, String(raw).trim());
  }
  return `https://github.com/${repository}/issues/new?${query}`;
}
