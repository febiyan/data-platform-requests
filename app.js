// The request page. It holds layout and behaviour only: every word, field and
// choice comes from requests.json, which gitops/scripts/site_data.py builds
// from schemas/request.v1.schema.json and the schemas it points at. A field's
// look follows from its shape in the schema:
//
//   list of teams or workspaces       select
//   one choice, needed, described     choice cards (required, or shown by x-show-if)
//   one choice otherwise              select
//   several choices, described        tick cards
//   several choices                   chips
//   a list of text                    text area, one per line
//   text                              text box
import { check, decide, fill, issueLink, issueTitle } from "./rules.js";

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";

// Icon outlines on a 24px grid. The schema names them (x-site icons).
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
  for (const d of ICONS[name] || ICONS.sparkle) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

let data;
let copy;
let form;
let touched = new Set();
let wasReady = false;

// An action's look, from its name <verb>-<group> and the schema's x-site.
function look(action) {
  const [verb, group] = action.split("-");
  return { ...data.site.verbs[verb], group, groupInfo: data.site.groups[group] };
}

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
  for (const match of String(text).matchAll(pattern)) {
    fragment.append(text.slice(last, match.index));
    if (match[1]) fragment.append(el("strong", { text: match[1] }));
    else if (match[2]) fragment.append(el("code", { text: match[2] }));
    else fragment.append(el("a", { href: match[4], target: "_blank", rel: "noopener noreferrer", text: match[3] }));
    last = match.index + match[0].length;
  }
  fragment.append(String(text).slice(last));
  return fragment;
}

const firstSentence = (text) => `${String(text).split(/(?<=\.)\s/)[0]}`;

function renderChrome() {
  document.title = data.title;
  $("brand").textContent = data.site.brand;
  $("heading").textContent = data.site.heading;
  $("lead").textContent = data.description;
  $("steps").replaceChildren(...data.site.steps.map((step) =>
    el("li", {}, el("span", { class: "step-icon" }, icon(step.icon)), el("span", {}, el("b", { text: step.title }), ` ${step.text}`))));
  $("preview-title").textContent = copy.preview;
  $("json-title").textContent = copy.requestJson;
  $("open-label").textContent = copy.open;
  $("copy-link").setAttribute("aria-label", copy.copyLink);
  $("copy-link").title = copy.copyLink;
  const repo = el("a", { href: `https://github.com/${data.repository}`, target: "_blank", rel: "noopener noreferrer", text: data.repository });
  $("access").replaceChildren(...fillNodes(copy.access, { repository: repo }));
  if (data.revision) {
    const commit = el("a", { href: `https://github.com/${data.repository}/commit/${data.revision}`, target: "_blank", rel: "noopener noreferrer", text: data.revision.slice(0, 7) });
    $("data-version").replaceChildren(...fillNodes(copy.dataAsOf, { revision: commit }));
  }
}

// fill() for templates whose values are elements, such as links.
function fillNodes(template, nodes) {
  return String(template).split(/(\{\w+\})/).map((part) => nodes[part.slice(1, -1)] ?? part);
}

function renderActions() {
  const groups = Object.entries(data.site.groups).map(([key, info]) => ({ info, forms: data.forms.filter((f) => look(f.action).group === key) }));
  $("actions").setAttribute("aria-label", data.site.heading);
  $("actions").replaceChildren(...groups.map(({ info, forms }) => el("section", { class: "group" },
    el("div", { class: "group-head" },
      el("span", { class: "group-icon" }, icon(info.icon)),
      el("div", {}, el("h2", { text: info.title }), el("p", { text: info.description }))),
    el("div", { class: "choices" }, ...forms.map((f) => {
      const { icon: name, danger } = look(f.action);
      const button = el("button", { type: "button", class: `choice${danger ? " danger" : ""}`, "data-action": f.action, "aria-pressed": "false" },
        el("span", { class: "choice-icon" }, icon(name)),
        el("span", { class: "choice-text" }, el("strong", { text: f.title }), el("span", { text: firstSentence(f.intro) })),
        el("span", { class: "choice-go" }, icon("chevron")));
      button.addEventListener("click", () => {
        if (location.hash === `#${f.action}`) $("workarea").scrollIntoView({ block: "start" });
        else location.hash = f.action;
      });
      return button;
    })))));
}

const described = (field) => (field.options || []).some((o) => o.description);
function control(field) {
  if (field.widget === "dropdown" && !field.source && (field.required || field.showIf) && described(field) && field.options.length <= 4) return "cards";
  if (field.widget === "checkboxes") return described(field) ? "tickCards" : "chips";
  if (field.widget === "dropdown") return "select";
  return field.widget;
}

function fieldControl(field) {
  const name = `f-${field.id}`;
  switch (control(field)) {
    case "cards":
    case "tickCards": {
      const type = control(field) === "cards" ? "radio" : "checkbox";
      return el("div", { class: `option-cards ${type}` }, ...field.options.map((o) =>
        el("label", { class: "option-card" }, el("input", { type, name, value: o.label }),
          el("span", { class: "option-body" },
            el("span", { class: "option-mark" }, icon("check")),
            el("span", { class: "option-text" }, el("strong", { text: o.label }), o.description ? el("span", { text: o.description }) : null)))));
    }
    case "chips":
      return el("div", { class: "chips" }, ...field.options.map((o) =>
        el("label", { class: "chip" }, el("input", { type: "checkbox", name, value: o.label }),
          el("span", {}, el("span", { class: "tick" }, icon("check")), o.label))));
    case "select": {
      const first = el("option", { value: "", text: field.required ? copy.choose : copy.none });
      return el("select", { id: name, name }, first, ...field.options.map((o) => el("option", { value: o.label, text: o.label })));
    }
    case "textarea":
      return el("textarea", { id: name, name, rows: 4, placeholder: field.example });
    default:
      return el("input", { type: "text", id: name, name, autocomplete: "off", placeholder: field.example });
  }
}

function renderForm(action) {
  form = data.forms.find((f) => f.action === action);
  touched = new Set();
  wasReady = false;
  const { icon: name, danger, groupInfo } = look(action);
  document.querySelectorAll(".choice").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.action === action)));
  $("workarea").hidden = false;
  for (const id of ["request", "preview"]) { const node = $(id); node.style.animation = "none"; void node.offsetWidth; node.style.animation = ""; }
  $("form-icon").className = `form-icon${danger ? " danger" : ""}`;
  $("form-icon").replaceChildren(icon(name));
  $("form-kicker").textContent = groupInfo.title;
  $("form-title").textContent = form.title;
  $("form-intro").replaceChildren(rich(form.intro));
  $("fields").replaceChildren(...form.fields.map((field) => {
    const group = ["cards", "tickCards", "chips"].includes(control(field));
    const labelRow = el("div", { class: "label-row" },
      el(group ? "legend" : "label", group ? {} : { for: `f-${field.id}` }, field.label),
      field.required ? el("span", { class: "badge", text: copy.required }) : null,
      el("span", { class: "valid-mark" }, icon("checkCircle")));
    const body = [labelRow, field.description ? el("p", { class: "hint", text: field.description }) : null, fieldControl(field),
      el("p", { class: "field-error", id: `e-${field.id}`, hidden: true })];
    return el("div", { class: "field", "data-field": field.id }, group ? el("fieldset", {}, ...body) : el("div", {}, ...body));
  }));
  prefillFromQuery();
  update();
}

function readValues() {
  const values = {};
  for (const field of form.fields) {
    const name = `f-${field.id}`;
    const kind = control(field);
    if (kind === "cards") values[field.id] = document.querySelector(`input[name="${name}"]:checked`)?.value ?? "";
    else if (kind === "tickCards" || kind === "chips") values[field.id] = [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
    else values[field.id] = $(name).value;
  }
  // x-show-if: a field shows once another one has a value (true) or a given choice.
  for (const field of form.fields.filter((f) => f.showIf)) {
    const [[key, wanted]] = Object.entries(field.showIf);
    const other = form.fields.find((f) => f.id === key);
    const picked = [].concat(values[key] || []).map((label) => other.options?.find((o) => o.label === label)?.value ?? label);
    const visible = wanted === true ? picked.some(Boolean) : picked.includes(wanted);
    const holder = document.querySelector(`[data-field="${field.id}"]`);
    if (visible && holder.hidden) { holder.classList.remove("appear"); void holder.offsetWidth; holder.classList.add("appear"); }
    holder.hidden = !visible;
    if (!visible) values[field.id] = "";
  }
  return values;
}

function optionFor(field, id) {
  return field.options?.find((o) => o.value === id || o.label === id);
}

function setValue(field, label) {
  const kind = control(field);
  if (kind === "select" || kind === "input" || kind === "textarea") $(`f-${field.id}`).value = label;
  else document.querySelectorAll(`input[name="f-${field.id}"]`).forEach((i) => { i.checked = [].concat(label).includes(i.value); });
}

// ?team=us-support or ?workspace=001 picks the team or workspace.
function prefillFromQuery() {
  const params = new URLSearchParams(location.search);
  for (const field of form.fields) {
    const found = params.get(field.id) && optionFor(field, params.get(field.id));
    if (found) setValue(field, found.label);
  }
  fillCurrent();
}

// A change form shows the current public values of what it changes.
function fillCurrent() {
  const picker = form.fields.find((f) => f.source === "teams" && f.id === "team");
  if (!picker || form.action !== "change-team") return;
  const picked = optionFor(picker, $(`f-${picker.id}`).value);
  const team = picked && data.teams.find((t) => t.id === picked.value);
  if (!team) return;
  for (const field of form.fields) {
    if (field === picker || !(field.id in team)) continue;
    const value = team[field.id];
    setValue(field, field.options ? (optionFor(field, value)?.label ?? "") : value);
  }
}

function card(kind, iconName, title, items) {
  if (!items.length) return null;
  return el("div", { class: `card ${kind}` },
    el("div", { class: "card-title" }, icon(iconName), title),
    el("ul", {}, ...items.map((item) => el("li", {}, rich(item)))));
}

const isEmpty = (value) => (Array.isArray(value) ? !value.length : !String(value || "").trim());

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
    if (show && !wasInvalid && field.id === changedField && !["input", "textarea"].includes(control(field))) {
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
  pill.replaceChildren(el("span", { class: "dot" }), result.ok ? copy.ready : fill(copy.toFixCount, { count: problems.length }));

  $("problems").replaceChildren(...[card("error", "alert", copy.toFix, problems), card("warn", "warn", copy.goodToKnow, result.warnings)].filter(Boolean));
  $("outcome").replaceChildren(result.outcome.length
    ? card(`outcome${result.ok ? " done" : ""}`, result.ok ? "checkCircle" : "sparkle", copy.whatHappens, result.outcome)
    : el("div", { class: "card muted", text: copy.outcomeEmpty }));

  const approval = decide(result.request, data.policy);
  $("approval").replaceChildren(el("div", { class: `card approval${approval.auto ? " auto" : ""}` },
    el("span", { class: "approval-icon" }, icon(approval.auto ? "bot" : "person")),
    el("div", {},
      el("strong", { text: approval.auto ? copy.approvedByBot : copy.approvedByPeople }),
      el("p", { text: approval.auto ? [approval.reason, approval.merge ? copy.botMerges : ""].join(" ").trim() : copy.peopleReason }))));
  $("request-json").textContent = JSON.stringify(result.request, null, 2);

  const link = issueLink(data.repository, form, values, issueTitle(form, result.request, data));
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
  const copyButton = $("copy-link");
  copyButton.disabled = !result.ok;
  copyButton.onclick = () => navigator.clipboard?.writeText(link).then(() => {
    copyButton.classList.add("copied");
    copyButton.replaceChildren(icon("check"));
    setTimeout(() => { copyButton.classList.remove("copied"); copyButton.replaceChildren(icon("copy")); }, 1500);
  });

  const ticks = form.fields.filter((f) => f.widget === "checkboxes" && values[f.id].length).map((f) => `${f.label}: ${values[f.id].join(", ")}`);
  const reminder = $("tick-reminder");
  reminder.hidden = !ticks.length;
  reminder.replaceChildren(...(ticks.length ? [icon("info"), el("span", { text: fill(copy.tickReminder, { ticks: ticks.join("; ") }) })] : []));
}

function onEdit(event) {
  const holder = event.target.closest("[data-field]");
  if (!holder) return;
  const id = holder.dataset.field;
  const typing = ["text", "textarea"].includes(event.target.type) || event.target.tagName === "TEXTAREA";
  // A text field counts as touched once you leave it, or once it holds a few characters.
  if (!typing || event.type !== "input" || touched.has(id) || event.target.value.length > 2) touched.add(id);
  if (id === "team") fillCurrent();
  update(id);
}

function route() {
  const action = location.hash.slice(1);
  if (data.forms.some((f) => f.action === action)) renderForm(action);
}

async function main() {
  document.querySelectorAll("[data-icon]").forEach((node) => node.replaceChildren(icon(node.dataset.icon)));
  try {
    const response = await fetch("requests.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`requests.json ${response.status}`);
    data = await response.json();
    copy = data.site.copy;
  } catch (error) {
    // The only words not from the schema: without requests.json there are none.
    $("actions").replaceChildren(el("div", { class: "load-error" }, icon("alert"), el("span", { text: error.message })));
    return;
  }
  renderChrome();
  renderActions();
  for (const type of ["input", "change", "focusout"]) $("request").addEventListener(type, onEdit);
  $("request").addEventListener("submit", (event) => event.preventDefault());
  window.addEventListener("hashchange", () => { route(); $("workarea").scrollIntoView({ block: "start" }); });
  route();
}

main();
