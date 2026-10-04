// The request page. It holds layout and behaviour only: every word, field and
// choice comes from requests.json, which gitops/scripts/site_data.py builds
// from schemas/request.v1.schema.json and the schemas it points at.
//
// Flow: pick a request, and the picker folds away. Fields appear one step at
// a time: everything up to the first required field still empty. Errors and
// notes sit under the field they are about, shown once you have left it, or
// on every field when you press the button too early. The review, with what
// will happen and who approves, appears once the request is complete.
//
// A field's look follows from its shape in the schema:
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
const DEBUG = new URLSearchParams(location.search).has("debug");

// Icon outlines on a 24px grid. The schema names them (x-site icons).
const ICONS = {
  layers: ["m12 2 10 5-10 5L2 7z", "m2 17 10 5 10-5", "m2 12 10 5 10-5"],
  users: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
  plus: ["M12 5v14", "M5 12h14"],
  pencil: ["M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z", "m15 5 4 4"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M10 11v6", "M14 11v6"],
  chevron: ["m9 18 6-6-6-6"],
  back: ["m15 18-6-6 6-6"],
  check: ["M20 6 9 17l-5-5"],
  checkCircle: ["M22 11.08V12a10 10 0 1 1-5.93-9.14", "M22 4 12 14.01l-3-3"],
  alert: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z", "M12 8v4", "M12 16h.01"],
  warn: ["M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z", "M12 9v4", "M12 17h.01"],
  sparkle: ["M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"],
  bot: ["M5 8h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z", "M12 8V4", "M9 14h.01", "M15 14h.01"],
  person: ["M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2", "M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"],
  external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  copy: ["M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"],
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
let lastLink = "";

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

// fill() for templates whose values are elements, such as links.
function fillNodes(template, nodes) {
  return String(template).split(/(\{\w+\})/).map((part) => nodes[part.slice(1, -1)] ?? part);
}

const firstSentence = (text) => String(text).split(/(?<=\.)\s/)[0];
const replay = (node, name) => { node.classList.remove(name); void node.offsetWidth; node.classList.add(name); };

function renderChrome() {
  document.title = data.title;
  $("brand").textContent = data.site.brand;
  $("heading").textContent = data.site.heading;
  $("lead").textContent = data.description;
  $("steps").replaceChildren(...data.site.steps.map((step) =>
    el("li", {}, el("span", { class: "step-icon" }, icon(step.icon)), el("span", {}, el("b", { text: step.title }), ` ${step.text}`))));
  $("back-label").textContent = copy.back;
  $("review-title").textContent = copy.whatHappens;
  $("json-title").textContent = copy.requestJson;
  $("technical").hidden = !DEBUG;
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

function renderActions() {
  const groups = Object.entries(data.site.groups).map(([key, info]) => ({ info, forms: data.forms.filter((f) => look(f.action).group === key) }));
  $("actions").setAttribute("aria-label", data.site.heading);
  $("actions").replaceChildren(...groups.map(({ info, forms }) => el("section", { class: "group" },
    el("div", { class: "group-head" },
      el("span", { class: "group-icon" }, icon(info.icon)),
      el("div", {}, el("h2", { text: info.title }), el("p", { text: info.description }))),
    el("div", { class: "choices" }, ...forms.map((f) => {
      const { icon: name, danger } = look(f.action);
      const button = el("button", { type: "button", class: `choice${danger ? " danger" : ""}`, "data-action": f.action },
        el("span", { class: "choice-icon" }, icon(name)),
        el("span", { class: "choice-text" }, el("strong", { text: f.title }), el("span", { text: firstSentence(f.intro) })),
        el("span", { class: "choice-go" }, icon("chevron")));
      button.addEventListener("click", () => { location.hash = f.action; });
      return button;
    })))));
}

// ---- Fields ----

const described = (field) => (field.options || []).some((o) => o.description);
function control(field) {
  if (field.widget === "dropdown" && !field.source && (field.required || field.showIf) && described(field) && field.options.length <= 4) return "cards";
  if (field.widget === "checkboxes") return described(field) ? "tickCards" : "chips";
  if (field.widget === "dropdown") return "select";
  return field.widget;
}
const grouped = (field) => ["cards", "tickCards", "chips"].includes(control(field));

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
      return el("select", { id: name, name, "aria-describedby": `m-${field.id}` }, first, ...field.options.map((o) => el("option", { value: o.label, text: o.label })));
    }
    case "textarea":
      return el("textarea", { id: name, name, rows: 3, placeholder: field.example, "aria-describedby": `m-${field.id}` });
    default:
      return el("input", { type: "text", id: name, name, autocomplete: "off", placeholder: field.example, "aria-describedby": `m-${field.id}` });
  }
}

function renderField(field) {
  const labelTag = grouped(field) ? "legend" : "label";
  const head = el("div", { class: "label-row" },
    el(labelTag, grouped(field) ? {} : { for: `f-${field.id}` }, field.label),
    !field.required && form.fields.filter((f) => f.required).length > 1 ? el("span", { class: "badge", text: copy.optional }) : null,
    el("span", { class: "valid-mark" }, icon("checkCircle")));
  const body = [head, field.description ? el("p", { class: "hint", text: field.description }) : null, fieldControl(field),
    el("div", { class: "field-messages", id: `m-${field.id}` })];
  return el("div", { class: "field", "data-field": field.id, hidden: true }, grouped(field) ? el("fieldset", {}, ...body) : el("div", {}, ...body));
}

function renderForm(action) {
  form = data.forms.find((f) => f.action === action);
  touched = new Set();
  wasReady = false;
  const { icon: name, danger, groupInfo } = look(action);
  document.body.classList.add("picked");
  $("actions").hidden = true;
  $("workarea").hidden = false;
  $("bar").hidden = false;
  replay($("workarea"), "enter");
  $("form-icon").className = `form-icon${danger ? " danger" : ""}`;
  $("form-icon").replaceChildren(icon(name));
  $("form-kicker").textContent = groupInfo.title;
  $("form-title").textContent = form.title;
  $("form-intro").replaceChildren(rich(form.intro));
  $("fields").replaceChildren(...form.fields.map(renderField));
  prefillFromQuery();
  update();
  window.scrollTo({ top: 0 });
}

function showPicker() {
  form = null;
  document.body.classList.remove("picked");
  $("actions").hidden = false;
  $("workarea").hidden = true;
  $("bar").hidden = true;
  replay($("actions"), "enter");
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
  return values;
}

const isEmpty = (value) => (Array.isArray(value) ? !value.length : !String(value || "").trim());

// Which fields show: x-show-if first, then everything up to and including the
// first required field that is still empty.
function visibleFields(values) {
  const shown = new Set();
  let blocked = false;
  for (const field of form.fields) {
    if (field.showIf) {
      const [[key, wanted]] = Object.entries(field.showIf);
      const other = form.fields.find((f) => f.id === key);
      const picked = [].concat(values[key] || []).map((label) => other.options?.find((o) => o.label === label)?.value ?? label);
      if (!(wanted === true ? picked.some(Boolean) : picked.includes(wanted))) continue;
    }
    if (blocked) continue;
    shown.add(field.id);
    if (field.required && isEmpty(values[field.id])) blocked = true;
  }
  return shown;
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
  if (form.action !== "change-team") return;
  const picker = form.fields.find((f) => f.id === "team");
  const picked = optionFor(picker, $("f-team").value);
  const team = picked && data.teams.find((t) => t.id === picked.value);
  if (!team) return;
  for (const field of form.fields) {
    if (field === picker || !(field.id in team)) continue;
    const value = team[field.id];
    setValue(field, field.options ? (optionFor(field, value)?.label ?? "") : value);
  }
}

// ---- Feedback ----

function update(changedField) {
  const values = readValues();
  const shown = visibleFields(values);
  for (const field of form.fields) if (!shown.has(field.id)) values[field.id] = field.widget === "checkboxes" ? [] : "";
  const result = check(form, values, data);
  const notesFor = (id) => result.warnings.filter((w) => w.field === id).map((w) => w.message);

  for (const field of form.fields) {
    const holder = document.querySelector(`[data-field="${field.id}"]`);
    const visible = shown.has(field.id);
    if (visible && holder.hidden) replay(holder, "appear");
    holder.hidden = !visible;
    const message = result.fieldErrors[field.id];
    const show = visible && Boolean(message) && touched.has(field.id);
    const wasInvalid = holder.classList.contains("invalid");
    holder.classList.toggle("invalid", show);
    holder.classList.toggle("valid", visible && !message && touched.has(field.id) && !isEmpty(values[field.id]));
    if (show && !wasInvalid && field.id === changedField && grouped(field)) replay(holder, "shake");
    const control_ = $(`f-${field.id}`);
    if (control_) control_.setAttribute("aria-invalid", String(show));
    const notes = visible && !show ? notesFor(field.id) : [];
    $(`m-${field.id}`).replaceChildren(
      ...(show ? [el("p", { class: "field-error" }, icon("alert"), el("span", { text: message }))] : []),
      ...notes.map((note) => el("p", { class: "field-note" }, icon("info"), el("span", { text: note }))));
  }

  // The review shows once the request is complete and valid.
  const review = $("review");
  const wasHidden = review.hidden;
  review.hidden = !result.ok;
  if (result.ok) {
    if (wasHidden) replay(review, "appear");
    $("outcome").replaceChildren(...result.outcome.map((line) => el("li", {}, icon("check"), el("span", {}, rich(line)))));
    $("notes").replaceChildren(...result.warnings.filter((w) => !w.field).map((w) => el("p", { class: "field-note" }, icon("info"), el("span", { text: w.message }))));
    // Who approves, in one line; the policy's reason shows on hover.
    const approval = decide(result.request, data.policy);
    const who = approval.auto ? (approval.merge ? copy.approvedAndMergedByBot : copy.approvedByBot) : copy.approvedByPeople;
    $("approval").replaceChildren(el("p", { class: `approval${approval.auto ? " auto" : ""}`, title: approval.reason },
      icon(approval.auto ? "bot" : "person"), el("span", { text: who })));
    $("request-json").textContent = JSON.stringify(result.request, null, 2);
  }

  // The bar: how far along, and the button.
  const missing = form.fields.filter((f) => f.required && isEmpty(values[f.id])).length;
  const wrong = Object.keys(result.fieldErrors).filter((id) => shown.has(id) && !isEmpty(values[id])).length + result.errors.length;
  const status = $("bar-status");
  status.className = `bar-status ${result.ok ? "ready" : ""}`;
  status.replaceChildren(icon(result.ok ? "checkCircle" : "info"),
    el("span", { text: result.ok ? copy.ready : missing ? fill(copy.requiredLeft, { count: missing }) : wrong ? fill(copy.toFixCount, { count: wrong }) : "" }));
  // A form-level refusal (nothing changed yet) shows in the bar, as it has no field.
  if (!result.ok && !missing && result.errors.length && touched.size) status.replaceChildren(icon("alert"), el("span", { text: result.errors[0] }));

  lastLink = issueLink(data.repository, form, values, issueTitle(form, result.request, data));
  const open = $("open-issue");
  open.classList.toggle("waiting", !result.ok);
  if (result.ok) {
    open.href = lastLink;
    if (!wasReady) replay(open, "ready");
  } else open.removeAttribute("href");
  wasReady = result.ok;
  $("copy-link").disabled = !result.ok;
}

// Pressed too early: show every problem where it is, and go to the first.
function revealProblems(event) {
  if (!$("open-issue").classList.contains("waiting")) return;
  event.preventDefault();
  const values = readValues();
  for (const id of visibleFields(values)) touched.add(id);
  update();
  const first = document.querySelector(".field.invalid") || [...document.querySelectorAll(".field:not([hidden])")].find((f) => {
    const field = form.fields.find((x) => x.id === f.dataset.field);
    return field.required && isEmpty(values[field.id]);
  });
  if (first) {
    first.scrollIntoView({ behavior: "smooth", block: "center" });
    first.querySelector("input, select, textarea")?.focus({ preventScroll: true });
    replay(first, "shake");
  } else replay($("bar-status"), "shake");
}

function onEdit(event) {
  const holder = event.target.closest("[data-field]");
  if (!holder) return;
  const id = holder.dataset.field;
  const typing = event.target.tagName === "TEXTAREA" || event.target.type === "text";
  // A text field counts as touched once you leave it; a choice as soon as you make it.
  if (!typing || event.type !== "input" || touched.has(id)) touched.add(id);
  if (id === "team") fillCurrent();
  update(id);
}

function route() {
  const action = location.hash.slice(1);
  if (data.forms.some((f) => f.action === action)) renderForm(action);
  else showPicker();
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
  $("open-issue").addEventListener("click", revealProblems);
  $("back").addEventListener("click", () => { history.pushState(null, "", location.pathname + location.search); showPicker(); });
  $("copy-link").addEventListener("click", () => navigator.clipboard?.writeText(lastLink).then(() => {
    const button = $("copy-link");
    button.classList.add("copied");
    button.replaceChildren(icon("check"));
    button.title = copy.copied;
    setTimeout(() => { button.classList.remove("copied"); button.replaceChildren(icon("copy")); button.title = copy.copyLink; }, 1500);
  }));
  window.addEventListener("hashchange", route);
  route();
}

main();
