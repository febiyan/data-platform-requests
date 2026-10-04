// The request rules, in the browser.
//
// Field rules (formats, lengths, counts, required fields, allowed values) come
// from the JSON schemas in requests.json: the page builds the team or
// workspace file a request would produce, as request.py does, and checks it
// against the schema. Change a schema and the page follows, with no code
// change here. Only the rules between files live in this file, mirroring
// request.py: a team exists, a team owns a workspace, a team's role in it.
// request.py stays the authority: the bot checks every request again.

const PLATFORM_NAMES = { databricks: "Databricks", powerbi: "Power BI" };
const GROUP_ROLES = { owner: "Owner", "workspace-contributor": "Contributor", "workspace-observer": "Observer" };
const PLATFORM_IDS = { databricks: "DBX", powerbi: "PBI" };

// Where a schema path lands in the form. Paths not listed land on the field
// named after their first step, e.g. costCenter or approvers/1.
const FIELD_OF = {
  "orgUnit/type": "orgUnitType", "orgUnit/name": "orgUnitName", orgUnit: "orgUnitType",
  "databricks/variant": "variant", "databricks/environments": "environments",
  "powerbi/environments": "environments", "powerbi/license/mode": "licenseMode",
  "powerbi/license": "licenseMode", "": "platforms",
};

export function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/^-+|-+$/g, "");
}

// ---- A small JSON Schema checker: the keywords the contract schemas use. ----

function resolve(root, node) {
  while (node && node.$ref) node = node.$ref.slice(2).split("/").reduce((n, key) => n[key], root);
  return node || {};
}

function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function validate(root, node, value, path = [], errors = [], when = null) {
  node = resolve(root, node);
  const fail = (keyword, extra = {}) => errors.push({ keyword, path, node, value, when, ...extra });
  if ("const" in node && !equal(value, node.const)) fail("const");
  if (node.enum && !node.enum.some((v) => equal(v, value))) fail("enum");
  if (typeof value === "string") {
    if (node.minLength != null && value.length < node.minLength) fail("minLength");
    if (node.maxLength != null && value.length > node.maxLength) fail("maxLength");
    if (node.pattern && !new RegExp(node.pattern, "u").test(value)) fail("pattern");
  }
  if (Array.isArray(value)) {
    if (node.minItems != null && value.length < node.minItems) fail("minItems");
    if (node.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) fail("uniqueItems");
    if (node.items) value.forEach((item, i) => validate(root, node.items, item, [...path, i], errors, when));
  } else if (value && typeof value === "object") {
    for (const key of node.required || []) {
      if (!(key in value)) errors.push({ keyword: "required", path: [...path, key], node: resolve(root, node.properties?.[key]), when });
    }
    for (const [key, item] of Object.entries(value)) {
      if (node.properties?.[key]) validate(root, node.properties[key], item, [...path, key], errors, when);
      else if (node.additionalProperties === false) fail("additionalProperties", { key });
    }
  }
  if (node.anyOf && !node.anyOf.some((option) => !validate(root, option, value, path).length)) fail("anyOf");
  if (node.not && !validate(root, node.not, value, path).length) fail("not");
  if (node.if) {
    const matched = !validate(root, node.if, value, path).length;
    const branch = matched ? node.then : node.else;
    if (branch) validate(root, branch, value, path, errors, matched ? node.if : null);
  }
  return errors;
}

function whenText(condition) {
  return Object.entries(condition.properties || {}).filter(([, rule]) => "const" in rule)
    .map(([key, rule]) => `${key} is ${rule.const}`).join(" and ");
}

// A schema error in words, for the form field it lands on.
function explain(error, field) {
  const what = error.node.description ? ` ${error.node.description}` : "";
  const items = error.node.items;
  switch (error.keyword) {
    case "required": return error.when ? `Required when ${whenText(error.when)}.` : "Required.";
    case "pattern": return `"${error.value}" doesn't fit.${what}`;
    case "minLength": return "Required.";
    case "maxLength": return `Up to ${error.node.maxLength} characters.`;
    case "minItems": return items?.enum
      ? `Pick at least ${error.node.minItems} of ${items.enum.join(", ")}.`
      : `Give at least ${error.node.minItems}${field?.type === "textarea" ? ", one per line" : ""}.`;
    case "uniqueItems": return "List each only once.";
    case "enum": return `Pick one of ${error.node.enum.map((v) => v ?? "none").join(", ")}.`;
    case "anyOf": return "Pick at least one.";
    case "not": return "This combination isn't allowed.";
    default: return `Not allowed (${error.keyword}).`;
  }
}

function schemaCheck(s, kind, doc, result, form, { partial = false } = {}) {
  for (const error of validate(s.schemas[kind], s.schemas[kind], doc)) {
    // A change only knows part of the file: skip "missing" for the rest.
    if (partial && error.keyword === "required" && error.path.length === 1 && !error.when) continue;
    const id = FIELD_OF[error.path.join("/")] ?? FIELD_OF[error.path.filter((p) => typeof p === "string").join("/")] ?? String(error.path[0]);
    const field = form.fields.find((f) => f.id === id);
    if (field) result.field(id, explain(error, field));
    else result.error(explain(error));
  }
}

// ---- From form answers to the request the bot reads. ----

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
    } else if (field.type === "textarea") {
      const lines = String(raw || "").split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length) request[field.id] = lines;
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

// ---- The files a request produces, as request.py writes them. ----

function teamDoc(base, request) {
  const doc = { ...base };
  for (const key of ["displayName", "reach", "costCenter", "approvers"]) if (key in request) doc[key] = request[key];
  if ("region" in request) doc.region = request.region;
  if (doc.reach === "global" || doc.region == null) delete doc.region;
  if ("orgUnitType" in request || "orgUnitName" in request) {
    doc.orgUnit = {};
    if (request.orgUnitType) doc.orgUnit.type = request.orgUnitType;
    if (request.orgUnitName) doc.orgUnit.name = request.orgUnitName;
  }
  return doc;
}

function platformPart(platform, request, wanted) {
  const environments = wanted.filter((e) => !(platform === "powerbi" && e === "stg"));
  if (platform === "databricks") return { ...(request.variant ? { variant: request.variant } : {}), environments };
  return { license: { mode: request.licenseMode || "pro" }, environments };
}

function index(state) {
  const teams = new Map(state.teams.map((t) => [t.id, t]));
  const workspaces = new Map(state.workspaces.map((w) => [w.id, w]));
  const ownerOf = (ws) => state.teams.find((t) => t.workspaces.some((e) => e.workspace === ws && e.role === "owner"));
  return { teams, workspaces, ownerOf, schemas: state.schemas };
}

function nextNumber(s) {
  let number = 1;
  while (s.workspaces.has(String(number).padStart(3, "0"))) number++;
  return String(number).padStart(3, "0");
}

function groups(platform, ws) {
  return Object.values(GROUP_ROLES).map((role) => `[[SEC-${PLATFORM_IDS[platform]}-${ws}-${role}]]`).join(" ");
}

function describe(platform, part, form) {
  const option = (id, value) => form.fields.find((f) => f.id === id)?.options?.find((o) => o.value === value)?.label ?? value;
  const kind = platform === "databricks" ? option("variant", part.variant) : `${option("licenseMode", part.license.mode)} licence`;
  return `${PLATFORM_NAMES[platform]}${kind ? ` (${kind})` : ""} in ${part.environments.join(", ")}`;
}

const checks = {
  "create-team"(request, form, s, result) {
    const id = slugify(request.displayName || "");
    if (request.displayName && !id) return result.field("displayName", "The name needs at least one letter or digit.");
    if (id && s.teams.has(id)) return result.field("displayName", `Team ${id} already exists; use Change a team.`);
    if (request.reach === "global" && request.region != null) result.warning("A global team has no business region: the region is dropped.");
    schemaCheck(s, "team", teamDoc({ formatVersion: "v1", kind: "team", id: id || "x" }, request), result, form);
    if (id) {
      result.outcome(`New team **${request.displayName}** with ID [[${id}]]. The ID never changes, even if the name does.`);
      result.outcome("Its approvers approve people joining it in My Access, and changes to it.");
    }
  },

  "change-team"(request, form, s, result) {
    const team = s.teams.get(request.team);
    if (!team) return result.field("team", "Pick a team.");
    const before = { formatVersion: "v1", kind: "team", id: team.id, displayName: team.displayName, reach: team.reach, ...(team.region ? { region: team.region } : {}) };
    const after = teamDoc(before, request);
    schemaCheck(s, "team", after, result, form, { partial: true });
    const changed = [];
    for (const field of form.fields.slice(1)) {
      if (!(field.id in request)) continue;
      const now = request[field.id];
      if (field.id === "region" && after.reach === "global") continue;
      if (field.id in before ? equal(now, before[field.id]) : (field.id === "region" && now == null && !team.region)) continue;
      const label = field.options?.find((o) => equal(o.value, now))?.label ?? (Array.isArray(now) ? now.join(", ") : now);
      changed.push(`${field.label.toLowerCase()} to **${label}**`);
    }
    if (after.reach === "global" && team.region) changed.push("business region removed, since the team is global");
    if (!changed.length) return result.error("Nothing changed yet. Edit the fields you want to change; empty fields keep their current value.");
    result.outcome(`Team **${team.displayName}**: ${changed.join("; ")}. Its ID stays [[${team.id}]].`);
  },

  "delete-team"(request, form, s, result) {
    const team = s.teams.get(request.team);
    if (!team) return result.field("team", "Pick a team.");
    const owned = team.workspaces.filter((e) => e.role === "owner").map((e) => e.workspace);
    if (owned.length) return result.field("team", `${team.displayName} owns workspace ${owned.join(", ")}. Remove it, or hand it over, first.`);
    result.outcome(`Team **${team.displayName}** is deleted.`);
    const joined = team.workspaces.map((e) => e.workspace);
    if (joined.length) result.warning(`It also leaves workspace ${joined.join(", ")}.`);
  },

  "create-workspace"(request, form, s, result) {
    const team = s.teams.get(request.team);
    if (request.team && !team) result.field("team", "Pick the team that will own the workspace.");
    const platforms = request.platforms || [];
    const ws = nextNumber(s);
    const doc = { formatVersion: "v1", kind: "workspace", id: ws };
    for (const p of platforms) doc[p] = platformPart(p, request, request.environments || []);
    schemaCheck(s, "workspace", doc, result, form);
    if (team && platforms.length) result.outcome(`Workspace **${ws}**, owned by **${team.displayName}**. The bot sets the number when the pull request opens.`);
    for (const p of platforms) {
      if (doc[p].environments.length) result.outcome(`${describe(p, doc[p], form)}. Groups ${groups(p, ws)}, created by the cyber security pipeline.`);
    }
    if (platforms.includes("powerbi") && (request.environments || []).includes("stg")) result.warning("Power BI has no stg: it is skipped for Power BI.");
    if (request.licenseMode === "premium") result.warning("Power BI Premium needs approval from your director and procurement before merge.");
  },

  "change-workspace"(request, form, s, result) {
    const current = s.workspaces.get(request.workspace);
    if (!current) return result.field("workspace", "Pick a workspace.");
    const doc = JSON.parse(JSON.stringify({ formatVersion: "v1", kind: "workspace", ...current }));
    const has = (p) => p in current;
    const changes = [];
    if (request.addPlatform) {
      const p = request.addPlatform;
      if (has(p)) result.field("addPlatform", `Workspace ${current.id} already has ${PLATFORM_NAMES[p]}.`);
      else {
        const wanted = request.environments || [...new Set(["databricks", "powerbi"].filter(has).flatMap((q) => current[q].environments))];
        doc[p] = platformPart(p, request, wanted);
        changes.push(`add ${describe(p, doc[p], form)}`);
      }
    }
    if (request.licenseMode && !request.addPlatform) {
      if (!has("powerbi")) result.field("licenseMode", "Only Power BI has a licence, and this workspace has no Power BI.");
      else { doc.powerbi.license.mode = request.licenseMode; changes.push(`Power BI ${request.licenseMode === "premium" ? "Premium" : "Pro"}`); }
    }
    if (request.environments && !request.addPlatform) {
      for (const p of ["databricks", "powerbi"].filter(has)) doc[p].environments = platformPart(p, request, request.environments).environments;
      changes.push(`environments ${request.environments.join(", ")}`);
    }
    schemaCheck(s, "workspace", doc, result, form);
    const roleIn = (teamId) => s.teams.get(teamId)?.workspaces.find((e) => e.workspace === current.id)?.role;
    let removed = null;
    if (request.removeTeam) {
      const team = s.teams.get(request.removeTeam);
      const role = roleIn(request.removeTeam);
      if (!role) result.field("removeTeam", `${team.displayName} has no role in workspace ${current.id}.`);
      else if (role === "owner") result.field("removeTeam", `${team.displayName} owns workspace ${current.id}; hand over ownership first.`);
      else { removed = team.id; changes.push(`${team.displayName} leaves`); }
    }
    if (request.addTeam) {
      const team = s.teams.get(request.addTeam);
      const role = request.addRole || "workspace-contributor";
      if (roleIn(request.addTeam) && removed !== team.id) {
        result.field("addTeam", `${team.displayName} already holds a role in workspace ${current.id}; remove it first to change the role.`);
      } else changes.push(`${team.displayName} joins as ${GROUP_ROLES[role].toLowerCase()}`);
    }
    if (!changes.length && !result.hasErrors()) return result.error("Nothing to change yet. Fill in only what changes.");
    const owner = s.ownerOf(current.id);
    if (changes.length) result.outcome(`Workspace **${current.id}**${owner ? ` (${owner.displayName})` : ""}: ${changes.join("; ")}.`);
    if (request.licenseMode === "premium") result.warning("Power BI Premium needs approval from your director and procurement before merge.");
  },

  "delete-workspace"(request, form, s, result) {
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
    error: (message) => { if (!errors.includes(message)) errors.push(message); },
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
  checks[form.action](request, form, index(state), result);
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
