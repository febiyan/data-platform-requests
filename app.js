// The request page: pick an action, fill the form, see the preview, open the
// prefilled GitHub issue. All data comes from requests.json, which
// gitops/scripts/site_data.py writes from the contract repository.
import { check, decide, issueLink } from "./rules.js";

const $ = (id) => document.getElementById(id);
const GROUPS = [
  { title: "Teams", actions: ["create-team", "change-team", "delete-team"] },
  { title: "Workspaces", actions: ["create-workspace", "change-workspace", "delete-workspace"] },
];
// Which optional fields matter, given the other answers.
const SHOWN = {
  "create-workspace": {
    variant: (v) => (v.platforms || []).includes("Databricks"),
    licenseMode: (v) => (v.platforms || []).includes("Power BI"),
  },
  "change-workspace": {
    addRole: (v) => Boolean(v.addTeam),
    variant: (v) => v.addPlatform === "Databricks",
  },
};
const KEEP_HINT = { input: "Leave empty to keep the current value.", textarea: "Leave empty to keep the current list.", dropdown: "Leave at None to keep the current value." };

let data;
let form;
let touched = new Set();

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === false || value == null) continue;
    if (key === "text") node.textContent = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

// **bold**, [[code]] and [text](https://...) only; everything else stays text.
function rich(text) {
  const fragment = document.createDocumentFragment();
  const pattern = /\*\*(.+?)\*\*|\[\[(.+?)\]\]|\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    fragment.append(text.slice(last, match.index));
    if (match[1]) fragment.append(el("strong", { text: match[1] }));
    else if (match[2]) fragment.append(el("code", { text: match[2] }));
    else fragment.append(el("a", { href: match[4], target: "_blank", rel: "noopener noreferrer", text: match[3] }));
    last = match.index + match[0].length;
  }
  fragment.append(text.slice(last));
  return fragment;
}

function renderActions() {
  const nav = $("actions");
  nav.replaceChildren(...GROUPS.map((group) => el("section", { class: "group" },
    el("h3", { text: group.title }),
    el("div", { class: "choices" }, ...group.actions.map((action) => {
      const f = data.forms.find((x) => x.action === action);
      const button = el("button", { type: "button", class: "choice", "data-action": action, "aria-pressed": "false" },
        el("strong", { text: f.title }), el("span", { text: f.intro.split(". ")[0].replace(/\.$/, "") + "." }));
      button.addEventListener("click", () => { location.hash = action; });
      return button;
    })))));
}

function fieldControl(field) {
  const name = `f-${field.id}`;
  if (field.type === "checkboxes") {
    return el("div", { class: "checks" }, ...field.options.map((o) =>
      el("label", {}, el("input", { type: "checkbox", name, value: o.label }), o.label)));
  }
  if (field.type === "dropdown") {
    const first = field.required ? el("option", { value: "", text: "Choose…" }) : el("option", { value: "", text: "None" });
    return el("select", { id: name, name }, first, ...field.options.map((o) => el("option", { value: o.label, text: o.label })));
  }
  if (field.type === "textarea") return el("textarea", { id: name, name, rows: 4 });
  return el("input", { type: "text", id: name, name, autocomplete: "off" });
}

function renderForm(action) {
  form = data.forms.find((f) => f.action === action);
  touched = new Set();
  document.querySelectorAll(".choice").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.action === action)));
  $("workarea").hidden = false;
  $("form-title").textContent = form.title;
  $("form-intro").replaceChildren(rich(form.intro));
  $("fields").replaceChildren(...form.fields.map((field) => {
    const keep = form.action === "change-team" && field.id !== "team";
    const hint = keep ? KEEP_HINT[field.type] : field.description;
    const label = field.type === "checkboxes"
      ? el("legend", {}, field.label, field.required ? el("span", { class: "required", text: " (required)" }) : null)
      : el("label", { for: `f-${field.id}` }, field.label, field.required ? el("span", { class: "required", text: " (required)" }) : null);
    const control = fieldControl(field);
    const body = [label, hint ? el("p", { class: "hint", text: hint }) : null, control, el("p", { class: "field-error", id: `e-${field.id}`, hidden: true })];
    return el("div", { class: "field", "data-field": field.id },
      field.type === "checkboxes" ? el("fieldset", {}, ...body) : el("div", {}, ...body));
  }));
  prefillFromQuery();
  update();
}

function readValues() {
  const values = {};
  for (const field of form.fields) {
    const name = `f-${field.id}`;
    values[field.id] = field.type === "checkboxes"
      ? [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value)
      : $(name).value;
  }
  const rules = SHOWN[form.action] || {};
  for (const [id, shown] of Object.entries(rules)) {
    const visible = shown(values);
    document.querySelector(`[data-field="${id}"]`).hidden = !visible;
    if (!visible) values[id] = "";
  }
  return values;
}

function optionFor(field, id) {
  return field.options?.find((o) => o.value === id || o.label === id);
}

// ?team=us-support or ?workspace=001 picks the team or workspace.
function prefillFromQuery() {
  const params = new URLSearchParams(location.search);
  for (const field of form.fields) {
    const wanted = params.get(field.id);
    if (!wanted || field.type !== "dropdown") continue;
    const found = optionFor(field, wanted);
    if (found) $(`f-${field.id}`).value = found.label;
  }
  if (form.action === "change-team") fillCurrentTeam();
}

// The change-team form shows the public current values, as the team list on GitHub does.
function fillCurrentTeam() {
  const picked = optionFor(form.fields[0], $("f-team").value);
  const team = picked && data.teams.find((t) => t.id === picked.value);
  if (!team) return;
  const label = (id, value) => optionFor(form.fields.find((f) => f.id === id), value)?.label ?? "";
  $("f-displayName").value = team.displayName;
  $("f-reach").value = label("reach", team.reach);
  $("f-region").value = label("region", team.region);
}

function issueTitle(request) {
  const id = request.team || request.workspace;
  switch (form.action) {
    case "create-team": return request.displayName ? `Create team ${request.displayName}` : form.title;
    case "change-team": return `Change team ${id || ""}`.trim();
    case "delete-team": return `Delete team ${id || ""}`.trim();
    case "create-workspace": {
      const team = data.teams.find((t) => t.id === request.team);
      return team ? `Request a workspace for ${team.displayName}` : form.title;
    }
    case "change-workspace": return `Change workspace ${id || ""}`.trim();
    default: return `Remove workspace ${id || ""}`.trim();
  }
}

function box(kind, title, items) {
  if (!items.length) return null;
  return el("div", { class: `box ${kind}` }, title ? el("strong", { text: title }) : null,
    el("ul", {}, ...items.map((item) => el("li", {}, rich(item)))));
}

function update() {
  const values = readValues();
  const result = check(form, values, data);

  for (const field of form.fields) {
    const message = result.fieldErrors[field.id];
    const show = Boolean(message) && touched.has(field.id);
    const holder = document.querySelector(`[data-field="${field.id}"]`);
    holder.classList.toggle("invalid", show);
    const error = $(`e-${field.id}`);
    error.hidden = !show;
    error.textContent = show ? message : "";
  }

  const problems = [
    ...form.fields.filter((f) => result.fieldErrors[f.id]).map((f) => `${f.label}: ${result.fieldErrors[f.id]}`),
    ...result.errors,
  ];
  $("problems").replaceChildren(...[
    box("error", "To fix before you can submit", problems),
    box("warn", null, result.warnings),
  ].filter(Boolean));
  $("outcome").replaceChildren(...[box(result.ok ? "ok" : "plain", "What will happen", result.outcome)].filter(Boolean));

  const approval = decide(result.request, data.policy);
  $("approval").replaceChildren(el("div", { class: "box plain" },
    el("strong", { text: approval.auto ? "Approved by the bot" : "Approved by people" }),
    el("p", { text: approval.auto ? `${approval.reason}${approval.merge ? " The bot also merges it once the checks pass." : ""}` : approval.reason })));
  $("request-json").textContent = JSON.stringify(result.request, null, 2);

  const link = issueLink(data.repository, form, values, issueTitle(result.request));
  const open = $("open-issue");
  if (result.ok) { open.href = link; open.setAttribute("aria-disabled", "false"); }
  else { open.removeAttribute("href"); open.setAttribute("aria-disabled", "true"); }
  $("copy-link").disabled = !result.ok;
  $("copy-link").onclick = () => navigator.clipboard?.writeText(link).then(() => { $("copy-link").textContent = "Copied"; setTimeout(() => { $("copy-link").textContent = "Copy link"; }, 1500); });

  const ticks = form.fields.filter((f) => f.type === "checkboxes" && values[f.id].length)
    .map((f) => `${f.label}: ${values[f.id].join(", ")}`);
  $("tick-reminder").hidden = !ticks.length;
  $("tick-reminder").textContent = ticks.length ? `If GitHub opens with boxes unticked, tick them again: ${ticks.join("; ")}.` : "";
}

function onEdit(event) {
  const holder = event.target.closest("[data-field]");
  if (!holder) return;
  touched.add(holder.dataset.field);
  if (form.action === "change-team" && holder.dataset.field === "team") fillCurrentTeam();
  update();
}

function route() {
  const action = location.hash.slice(1);
  if (data.forms.some((f) => f.action === action)) renderForm(action);
}

async function main() {
  try {
    const response = await fetch("requests.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`requests.json: ${response.status}`);
    data = await response.json();
  } catch (error) {
    $("actions").replaceChildren(el("div", { class: "box error", text: `The request data could not be loaded (${error.message}). Use the issue forms on GitHub instead.` }));
    return;
  }
  $("repo-name").replaceChildren(el("a", { href: `https://github.com/${data.repository}`, target: "_blank", rel: "noopener noreferrer", text: data.repository }));
  if (data.revision) {
    $("data-version").replaceChildren("Teams and workspaces as of ",
      el("a", { href: `https://github.com/${data.repository}/commit/${data.revision}`, target: "_blank", rel: "noopener noreferrer", text: data.revision.slice(0, 7) }),
      ". The bot checks every request again against the latest state.");
  }
  renderActions();
  $("request").addEventListener("input", onEdit);
  $("request").addEventListener("change", onEdit);
  $("request").addEventListener("submit", (event) => event.preventDefault());
  window.addEventListener("hashchange", () => { route(); $("workarea").scrollIntoView({ behavior: "smooth", block: "start" }); });
  route();
}

main();
