// The request page: pick an action, fill the form, see the preview, open the
// prefilled GitHub issue. All data comes from requests.json, which
// gitops/scripts/site_data.py writes from the contract repository: the forms
// from forms.py, the rules from the schemas, the teams and workspaces from
// desired-state/. Nothing here lists a field or a choice by hand.
import { check, decide, issueLink } from "./rules.js";

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";

// Icon outlines on a 24px grid.
const ICONS = {
  layers: ["m12 2 10 5-10 5L2 7z", "m2 17 10 5 10-5", "m2 12 10 5 10-5"],
  users: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
  plus: ["M12 5v14", "M5 12h14"],
  pencil: ["M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z", "m15 5 4 4"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M10 11v6", "M14 11v6"],
  chevron: ["m9 18 6-6-6-6"],
  check: ["M20 6 9 17l-5-5"],
  checkCircle: ["M22 11.08V12a10 10 0 1 1-5.93-9.14", "M22 4 12 14.01l-3-3"],
  alert: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z", "M12 8v4", "M12 16h.01"],
  warn: ["M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z", "M12 9v4", "M12 17h.01"],
  sparkle: ["M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"],
  bot: ["M5 8h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z", "M12 8V4", "M9 14h.01", "M15 14h.01"],
  person: ["M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2", "M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"],
  external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  copy: ["M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"],
  code: ["m16 18 6-6-6-6", "m8 6-6 6 6 6"],
  shield: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z", "m9 12 2 2 4-4"],
  pointer: ["m3 3 7.07 16.97 2.51-7.39 7.39-2.51z", "m13 13 6 6"],
  send: ["M22 2 11 13", "M22 2 15 22l-4-9-9-4z"],
  info: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z", "M12 16v-4", "M12 8h.01"],
};

function icon(name) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

// What an action looks like, from its name: <verb>-<team|workspace>.
const VERB = { create: { icon: "plus" }, change: { icon: "pencil" }, delete: { icon: "trash", danger: true } };
const NOUN = {
  team: { icon: "users", title: "Teams", blurb: "The people who own and join workspaces" },
  workspace: { icon: "layers", title: "Workspaces", blurb: "Databricks and Power BI, one number" },
};
const look = (action) => { const [verb, noun] = action.split("-"); return { ...VERB[verb], noun }; };

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
let wasReady = false;

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
  const groups = Object.entries(NOUN).map(([noun, meta]) => ({ noun, meta, forms: data.forms.filter((f) => look(f.action).noun === noun) }));
  $("actions").replaceChildren(...groups.map(({ meta, forms }) => el("section", { class: "group" },
    el("div", { class: "group-head" },
      el("span", { class: "group-icon" }, icon(meta.icon)),
      el("div", {}, el("h2", { text: meta.title }), el("p", { text: meta.blurb }))),
    el("div", { class: "choices" }, ...forms.map((f) => {
      const { icon: name, danger } = look(f.action);
      const button = el("button", { type: "button", class: `choice${danger ? " danger" : ""}`, "data-action": f.action, "aria-pressed": "false" },
        el("span", { class: "choice-icon" }, icon(name)),
        el("span", { class: "choice-text" }, el("strong", { text: f.title }), el("span", { text: f.intro.split(". ")[0].replace(/\.$/, "") + "." })),
        el("span", { class: "choice-go" }, icon("chevron")));
      button.addEventListener("click", () => {
        if (location.hash === `#${f.action}`) $("workarea").scrollIntoView({ block: "start" });
        else location.hash = f.action;
      });
      return button;
    })))));
}

function fieldControl(field) {
  const name = `f-${field.id}`;
  if (field.type === "checkboxes") {
    return el("div", { class: "chips" }, ...field.options.map((o) =>
      el("label", { class: "chip" }, el("input", { type: "checkbox", name, value: o.label }),
        el("span", {}, el("span", { class: "tick" }, icon("check")), o.label))));
  }
  if (field.type === "dropdown") {
    const first = field.required ? el("option", { value: "", text: "Choose…" }) : el("option", { value: "", text: "None" });
    return el("select", { id: name, name }, first, ...field.options.map((o) => el("option", { value: o.label, text: o.label })));
  }
  if (field.type === "textarea") return el("textarea", { id: name, name, rows: 4, placeholder: field.placeholder || null });
  return el("input", { type: "text", id: name, name, autocomplete: "off", placeholder: field.placeholder || null });
}

function renderForm(action) {
  form = data.forms.find((f) => f.action === action);
  touched = new Set();
  wasReady = false;
  const { icon: name, danger, noun } = look(action);
  document.querySelectorAll(".choice").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.action === action)));
  $("workarea").hidden = false;
  for (const id of ["request", "preview"]) { const node = $(id); node.style.animation = "none"; void node.offsetWidth; node.style.animation = ""; }
  $("form-icon").className = `form-icon${danger ? " danger" : ""}`;
  $("form-icon").replaceChildren(icon(name));
  $("form-kicker").textContent = NOUN[noun].title.replace(/s$/, "");
  $("form-title").textContent = form.title;
  $("form-intro").replaceChildren(rich(form.intro));
  $("fields").replaceChildren(...form.fields.map((field) => {
    const keep = form.action === "change-team" && field.id !== "team";
    const hint = keep ? KEEP_HINT[field.type] : field.description;
    const labelTag = field.type === "checkboxes" ? "legend" : "label";
    const labelRow = el("div", { class: "label-row" },
      el(labelTag, field.type === "checkboxes" ? {} : { for: `f-${field.id}` }, field.label),
      field.required ? el("span", { class: "badge", text: "Required" }) : null,
      el("span", { class: "valid-mark" }, icon("checkCircle")));
    const body = [labelRow, hint ? el("p", { class: "hint", text: hint }) : null, fieldControl(field),
      el("p", { class: "field-error", id: `e-${field.id}`, hidden: true })];
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
  for (const [id, shown] of Object.entries(SHOWN[form.action] || {})) {
    const holder = document.querySelector(`[data-field="${id}"]`);
    const visible = shown(values);
    if (visible && holder.hidden) { holder.classList.remove("appear"); void holder.offsetWidth; holder.classList.add("appear"); }
    holder.hidden = !visible;
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
  for (const field of form.fields.slice(1)) {
    if (!(field.id in team)) continue;
    const value = team[field.id];
    $(`f-${field.id}`).value = field.options ? (optionFor(field, value)?.label ?? "") : value;
  }
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

function card(kind, iconName, title, items) {
  if (!items.length) return null;
  return el("div", { class: `card ${kind}` },
    el("div", { class: "card-title" }, icon(iconName), title),
    el("ul", {}, ...items.map((item) => el("li", {}, rich(item)))));
}

function isEmpty(value) {
  return Array.isArray(value) ? !value.length : !String(value || "").trim();
}

function update(changedField) {
  const values = readValues();
  const result = check(form, values, data);

  for (const field of form.fields) {
    const message = result.fieldErrors[field.id];
    const show = Boolean(message) && touched.has(field.id);
    const holder = document.querySelector(`[data-field="${field.id}"]`);
    const wasInvalid = holder.classList.contains("invalid");
    holder.classList.toggle("invalid", show);
    holder.classList.toggle("valid", !message && touched.has(field.id) && !isEmpty(values[field.id]));
    if (show && !wasInvalid && field.id === changedField && field.type !== "input" && field.type !== "textarea") {
      holder.classList.remove("shake"); void holder.offsetWidth; holder.classList.add("shake");
    }
    const error = $(`e-${field.id}`);
    error.hidden = !show;
    error.replaceChildren(...(show ? [icon("alert"), el("span", { text: message })] : []));
  }

  const problems = [
    ...form.fields.filter((f) => result.fieldErrors[f.id]).map((f) => `**${f.label}**: ${result.fieldErrors[f.id]}`),
    ...result.errors,
  ];
  const pill = $("status-pill");
  pill.className = `pill ${result.ok ? "ready" : "todo"}`;
  pill.replaceChildren(el("span", { class: "dot" }), result.ok ? "Ready to submit" : `${problems.length} to fix`);

  $("problems").replaceChildren(...[
    card("error", "alert", "To fix", problems),
    card("warn", "warn", "Good to know", result.warnings),
  ].filter(Boolean));
  $("outcome").replaceChildren(result.outcome.length
    ? card(`outcome${result.ok ? " done" : ""}`, result.ok ? "checkCircle" : "sparkle", "What will happen", result.outcome)
    : el("div", { class: "card muted", text: "Fill in the form to see what will happen." }));

  const approval = decide(result.request, data.policy);
  $("approval").replaceChildren(el("div", { class: `card approval${approval.auto ? " auto" : ""}` },
    el("span", { class: "approval-icon" }, icon(approval.auto ? "bot" : "person")),
    el("div", {},
      el("strong", { text: approval.auto ? "Approved by the bot" : "Approved by people" }),
      el("p", { text: approval.auto ? `${approval.reason}${approval.merge ? " The bot also merges it once the checks pass." : ""}` : approval.reason }))));
  $("request-json").textContent = JSON.stringify(result.request, null, 2);

  const link = issueLink(data.repository, form, values, issueTitle(result.request));
  const open = $("open-issue");
  if (result.ok) {
    open.href = link;
    open.setAttribute("aria-disabled", "false");
    if (!wasReady) { open.classList.remove("ready"); void open.offsetWidth; open.classList.add("ready"); }
  } else {
    open.removeAttribute("href");
    open.setAttribute("aria-disabled", "true");
  }
  wasReady = result.ok;
  const copy = $("copy-link");
  copy.disabled = !result.ok;
  copy.onclick = () => navigator.clipboard?.writeText(link).then(() => {
    copy.classList.add("copied");
    copy.replaceChildren(icon("check"));
    setTimeout(() => { copy.classList.remove("copied"); copy.replaceChildren(icon("copy")); }, 1500);
  });

  const ticks = form.fields.filter((f) => f.type === "checkboxes" && values[f.id].length)
    .map((f) => `${f.label}: ${values[f.id].join(", ")}`);
  const reminder = $("tick-reminder");
  reminder.hidden = !ticks.length;
  reminder.replaceChildren(...(ticks.length ? [icon("info"), el("span", { text: `If GitHub opens with boxes unticked, tick them again: ${ticks.join("; ")}.` })] : []));
}

function onEdit(event) {
  const holder = event.target.closest("[data-field]");
  if (!holder) return;
  const id = holder.dataset.field;
  // Text fields count as touched once you leave them, or as soon as they hold something.
  if (event.type === "change" || event.type === "focusout" || !["INPUT", "TEXTAREA"].includes(event.target.tagName) || event.target.type === "checkbox") touched.add(id);
  else if (touched.has(id) || event.target.value.length > 2) touched.add(id);
  if (form.action === "change-team" && id === "team") fillCurrentTeam();
  update(id);
}

function route() {
  const action = location.hash.slice(1);
  if (data.forms.some((f) => f.action === action)) renderForm(action);
}

function placeIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((node) => node.replaceChildren(icon(node.dataset.icon)));
}

async function main() {
  placeIcons();
  try {
    const response = await fetch("requests.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`requests.json: ${response.status}`);
    data = await response.json();
  } catch (error) {
    $("actions").replaceChildren(el("div", { class: "load-error" }, icon("alert"),
      el("span", { text: `The request data could not be loaded (${error.message}). Use the issue forms on GitHub instead.` })));
    return;
  }
  $("repo-name").replaceChildren(el("a", { href: `https://github.com/${data.repository}`, target: "_blank", rel: "noopener noreferrer", text: data.repository }));
  if (data.revision) {
    $("data-version").replaceChildren("Teams and workspaces as of ",
      el("a", { href: `https://github.com/${data.repository}/commit/${data.revision}`, target: "_blank", rel: "noopener noreferrer", text: data.revision.slice(0, 7) }),
      ". The bot checks every request again against the latest state.");
  }
  renderActions();
  for (const type of ["input", "change", "focusout"]) $("request").addEventListener(type, onEdit);
  $("request").addEventListener("submit", (event) => event.preventDefault());
  window.addEventListener("hashchange", () => { route(); $("workarea").scrollIntoView({ block: "start" }); });
  route();
}

main();
