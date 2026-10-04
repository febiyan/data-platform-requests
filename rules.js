// The request rules, in the browser. No words live here: every sentence is a
// template from schemas/request.v1.schema.json (x-site and each action's
// x-outcome), and every label from the schemas it points at.
//
// Field rules (formats, lengths, counts, required fields, allowed values) come
// from the team and workspace schemas: the page builds the file a request
// would produce, as request.py does, and checks it against the schema. Only
// the rules between files are code here, mirroring request.py: a team exists,
// owns a workspace, already has a role in it. request.py stays the authority.

// Where a path in a team or workspace file lands in the form. Paths not listed
// land on the field named after their first step, e.g. costCenter, approvers/1.
const FIELD_OF = {
  "orgUnit/type": "orgUnitType", "orgUnit/name": "orgUnitName", orgUnit: "orgUnitType",
  "databricks/variant": "variant", "databricks/environments": "environments",
  "powerbi/environments": "environments", "powerbi/license/mode": "licenseMode",
  "powerbi/license": "licenseMode", "": "platforms",
};
const PLATFORMS = ["databricks", "powerbi"];

export function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/^-+|-+$/g, "");
}

// "{name} is {value}" with the values filled in.
export function fill(template, vars = {}) {
  return String(template ?? "").replace(/\{([\w.]+)\}/g, (_, key) => (vars[key] ?? `{${key}}`));
}

function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- A small JSON Schema checker: the keywords the contract schemas use. ----

function resolve(root, node) {
  while (node && node.$ref) node = node.$ref.slice(2).split("/").reduce((n, key) => n[key], root);
  return node || {};
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

// ---- Words: labels from the form, sentences from the schema's templates. ----

function words(state) {
  const site = state.site;
  const fieldOf = (form, id) => form.fields.find((f) => f.id === id);
  const label = (form, id, value) => fieldOf(form, id)?.options?.find((o) => equal(o.value, value))?.label ?? value;
  return { site, fieldOf, label };
}

// A schema error in words, for the form field it lands on.
function explain(error, form, field, w) {
  const m = w.site.messages;
  const choices = (values) => values.map((v) => (field ? w.label(form, field.id, v) : v) ?? "—").join(", ");
  switch (error.keyword) {
    case "required": {
      if (!error.when) return m.required;
      const [key, rule] = Object.entries(error.when.properties || {}).find(([, r]) => "const" in r) || [];
      return fill(m.requiredWhen, { field: w.fieldOf(form, key)?.label ?? key, value: w.label(form, key, rule?.const) });
    }
    case "pattern": return fill(m.pattern, { value: error.value, description: error.node.description || "" }).trim();
    case "minLength": return m.required;
    case "maxLength": return fill(m.maxLength, { limit: error.node.maxLength });
    case "minItems":
      if (error.node.items?.enum) return fill(m.minItemsChoice, { limit: error.node.minItems, choices: choices(error.node.items.enum) });
      return fill(field?.list ? m.minItemsLines : m.minItems, { limit: error.node.minItems });
    case "uniqueItems": return m.uniqueItems;
    case "enum": return fill(m.enum, { choices: choices(error.node.enum) });
    case "anyOf": return m.anyOf;
    case "not": return m.not;
    default: return fill(m.other, { keyword: error.keyword });
  }
}

function schemaCheck(s, kind, doc, result, form, { partial = false } = {}) {
  for (const error of validate(s.schemas[kind], s.schemas[kind], doc)) {
    // A change only knows part of the file: skip "missing" for the rest.
    if (partial && error.keyword === "required" && error.path.length === 1 && !error.when) continue;
    const id = FIELD_OF[error.path.join("/")] ?? FIELD_OF[error.path.filter((p) => typeof p === "string").join("/")] ?? String(error.path[0]);
    const field = s.w.fieldOf(form, id);
    if (field) result.field(id, explain(error, form, field, s.w));
    else result.error(explain(error, form, null, s.w));
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
    if (field.widget === "checkboxes") {
      const picked = (raw || []).map((label) => optionValue(field, label));
      if (picked.length) request[field.id] = picked;
    } else if (field.widget === "dropdown") {
      if (!raw) continue;
      const value = optionValue(field, raw);
      if (value !== null || field.id === "region") request[field.id] = value;
    } else if (field.list) {
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
  return { auto: false, merge: false, reason: null };
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
  return { teams, workspaces, ownerOf, schemas: state.schemas, w: words(state) };
}

function nextNumber(s) {
  let number = 1;
  while (s.workspaces.has(String(number).padStart(3, "0"))) number++;
  return String(number).padStart(3, "0");
}

// SEC-<platform>-<number>-<role>, from the workspace schema's x-access-groups.
function groups(s, platform, ws) {
  const naming = s.schemas.workspace["x-access-groups"];
  return Object.values(naming.roles).map((role) => `[[${fill(naming.pattern, { platform: naming.platforms[platform], workspace: ws, role })}]]`).join(" ");
}

function platformVars(s, form, platform, part) {
  const w = s.w;
  const platformName = w.label(form, form.fields.some((f) => f.id === "platforms") ? "platforms" : "addPlatform", platform);
  const kind = platform === "databricks" ? w.label(form, "variant", part.variant) : w.label(form, "licenseMode", part.license.mode);
  return { platform: platformName, kind: kind ?? "", environments: part.environments.join(", ") };
}

const checks = {
  "create-team"(request, form, s, result) {
    const { refusals, warnings } = s.w.site;
    const id = slugify(request.displayName || "");
    if (request.displayName && !id) return result.field("displayName", refusals.nameNeedsLetters);
    if (id && s.teams.has(id)) return result.field("displayName", fill(refusals.teamExists, { id }));
    if (request.reach === "global" && request.region != null) result.warning(warnings.regionDropped);
    schemaCheck(s, "team", teamDoc({ formatVersion: "v1", kind: "team", id: id || "x" }, request), result, form);
    if (id) {
      result.outcome(fill(form.outcome.created, { name: request.displayName, id }));
      result.outcome(form.outcome.approvers);
    }
  },

  "change-team"(request, form, s, result) {
    const { refusals } = s.w.site;
    const team = s.teams.get(request.team);
    if (!team) return result.field("team", refusals.pickTeam);
    const before = { formatVersion: "v1", kind: "team", id: team.id, displayName: team.displayName, reach: team.reach, ...(team.region ? { region: team.region } : {}) };
    const after = teamDoc(before, request);
    schemaCheck(s, "team", after, result, form, { partial: true });
    const changed = [];
    for (const field of form.fields.slice(1)) {
      if (!(field.id in request)) continue;
      const now = request[field.id];
      if (field.id === "region" && after.reach === "global") continue;
      if (field.id in before ? equal(now, before[field.id]) : (field.id === "region" && now == null && !team.region)) continue;
      const value = field.options?.find((o) => equal(o.value, now))?.label ?? (Array.isArray(now) ? now.join(", ") : now);
      changed.push(fill(form.outcome.change, { field: field.label, value }));
    }
    if (after.reach === "global" && team.region) changed.push(form.outcome.regionDropped);
    if (!changed.length) return result.error(refusals.nothingChangedTeam);
    result.outcome(fill(form.outcome.changed, { name: team.displayName, changes: changed.join("; "), id: team.id }));
  },

  "delete-team"(request, form, s, result) {
    const { refusals, warnings } = s.w.site;
    const team = s.teams.get(request.team);
    if (!team) return result.field("team", refusals.pickTeam);
    const owned = team.workspaces.filter((e) => e.role === "owner").map((e) => e.workspace);
    if (owned.length) return result.field("team", fill(refusals.ownsWorkspaces, { team: team.displayName, workspaces: owned.join(", ") }));
    result.outcome(fill(form.outcome.deleted, { name: team.displayName }));
    const joined = team.workspaces.map((e) => e.workspace);
    if (joined.length) result.warning(fill(warnings.leavesWorkspaces, { workspaces: joined.join(", ") }));
  },

  "create-workspace"(request, form, s, result) {
    const { refusals, warnings } = s.w.site;
    const team = s.teams.get(request.team);
    if (request.team && !team) result.field("team", refusals.pickTeam);
    const platforms = request.platforms || [];
    const ws = nextNumber(s);
    const doc = { formatVersion: "v1", kind: "workspace", id: ws };
    for (const p of platforms) doc[p] = platformPart(p, request, request.environments || []);
    schemaCheck(s, "workspace", doc, result, form);
    if (team && platforms.length) result.outcome(fill(form.outcome.created, { workspace: ws, name: team.displayName }));
    for (const p of platforms) {
      if (doc[p].environments.length) result.outcome(fill(form.outcome.platform, { ...platformVars(s, form, p, doc[p]), groups: groups(s, p, ws) }));
    }
    if (platforms.includes("powerbi") && (request.environments || []).includes("stg")) result.warning(warnings.noStgForPowerBi);
    if (request.licenseMode === "premium") result.warning(warnings.premiumApproval);
  },

  "change-workspace"(request, form, s, result) {
    const { refusals, warnings } = s.w.site;
    const o = form.outcome;
    const current = s.workspaces.get(request.workspace);
    if (!current) return result.field("workspace", refusals.pickWorkspace);
    const doc = JSON.parse(JSON.stringify({ formatVersion: "v1", kind: "workspace", ...current }));
    const has = (p) => p in current;
    const vars = { workspace: current.id };
    const changes = [];
    if (request.addPlatform) {
      const p = request.addPlatform;
      if (has(p)) result.field("addPlatform", fill(refusals.alreadyHasPlatform, { ...vars, platform: s.w.label(form, "addPlatform", p) }));
      else {
        const wanted = request.environments || [...new Set(PLATFORMS.filter(has).flatMap((q) => current[q].environments))];
        doc[p] = platformPart(p, request, wanted);
        changes.push(fill(o.addPlatform, platformVars(s, form, p, doc[p])));
      }
    }
    if (request.licenseMode && !request.addPlatform) {
      if (!has("powerbi")) result.field("licenseMode", fill(refusals.noLicence, vars));
      else { doc.powerbi.license.mode = request.licenseMode; changes.push(fill(o.licence, { licence: s.w.label(form, "licenseMode", request.licenseMode) })); }
    }
    if (request.environments && !request.addPlatform) {
      for (const p of PLATFORMS.filter(has)) doc[p].environments = platformPart(p, request, request.environments).environments;
      changes.push(fill(o.environments, { environments: request.environments.join(", ") }));
    }
    schemaCheck(s, "workspace", doc, result, form);
    const roleIn = (teamId) => s.teams.get(teamId)?.workspaces.find((e) => e.workspace === current.id)?.role;
    let removed = null;
    if (request.removeTeam) {
      const team = s.teams.get(request.removeTeam);
      const role = roleIn(request.removeTeam);
      const teamVars = { ...vars, team: team.displayName };
      if (!role) result.field("removeTeam", fill(refusals.noRole, teamVars));
      else if (role === "owner") result.field("removeTeam", fill(refusals.ownerCannotLeave, teamVars));
      else { removed = team.id; changes.push(fill(o.leaves, teamVars)); }
    }
    if (request.addTeam) {
      const team = s.teams.get(request.addTeam);
      const role = request.addRole || "workspace-contributor";
      const teamVars = { ...vars, team: team.displayName, role: String(s.w.label(form, "addRole", role)).toLowerCase() };
      if (roleIn(request.addTeam) && removed !== team.id) result.field("addTeam", fill(refusals.alreadyHasRole, teamVars));
      else changes.push(fill(o.joins, teamVars));
    }
    if (!changes.length && !result.hasErrors()) return result.error(refusals.nothingChangedWorkspace);
    const owner = s.ownerOf(current.id);
    if (changes.length) result.outcome(fill(o.changed, { ...vars, name: owner?.displayName ?? "", changes: changes.join("; ") }));
    if (request.licenseMode === "premium") result.warning(warnings.premiumApproval);
  },

  "delete-workspace"(request, form, s, result) {
    const { refusals } = s.w.site;
    const ws = s.workspaces.get(request.workspace);
    if (!ws) return result.field("workspace", refusals.pickWorkspace);
    const teams = [...s.teams.values()].filter((t) => t.workspaces.some((e) => e.workspace === ws.id)).map((t) => t.displayName);
    result.outcome(fill(form.outcome.removed, { workspace: ws.id }));
    if (teams.length) result.outcome(fill(form.outcome.teams, { teams: teams.join(", ") }));
    result.outcome(form.outcome.data);
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
  const m = state.site.messages;
  for (const field of form.fields) {
    const raw = values[field.id];
    const empty = Array.isArray(raw) ? !raw.length : !String(raw || "").trim();
    if (field.required && empty) result.field(field.id, field.widget === "checkboxes" ? m.tickOne : m.required);
  }
  checks[form.action](request, form, index(state), result);
  return { request, fieldErrors, errors, warnings, outcome, ok: !result.hasErrors() };
}

// The issue title, from the action's x-issue-title: {field} is the answer,
// {field.name} the display name of the team it picks.
export function issueTitle(form, request, state) {
  const vars = { ...request };
  for (const [key, value] of Object.entries(request)) {
    const team = state.teams.find((t) => t.id === value);
    if (team) vars[`${key}.name`] = team.displayName;
  }
  const title = fill(form.issueTitle, vars);
  return /\{[\w.]+\}/.test(title) ? form.title : title;
}

// A new-issue link that opens the issue form with the answers filled in.
// GitHub fills each field from the query parameter named after its id.
export function issueLink(repository, form, values, title) {
  const query = new URLSearchParams({ template: `${form.template}.yml`, title });
  for (const field of form.fields) {
    const raw = values[field.id];
    if (Array.isArray(raw)) { if (raw.length) query.set(field.id, raw.join(",")); }
    else if (String(raw || "").trim()) query.set(field.id, String(raw).trim());
  }
  return `https://github.com/${repository}/issues/new?${query}`;
}
