// Boxology Agents frontend. Plain JS, no build step, per the blueprint's
// "don't introduce a bundler unless genuinely needed" rule. One hand-rolled
// SSE-over-POST parser (fetch + ReadableStream), reused for all three agents
// -- native EventSource can't POST JSON or carry the CSRF-style header this
// app would add if auth were turned on.

const AGENT_DESCRIPTIONS = {
  scholar: "Explore your paper collection with answers grounded in sources.",
  anvil: "Discuss a system design, then generate a diagram for Tool4Boxology.",
  cartographer: "Explore graph queries, structural rules, and labeled nodes.",
};
// Plain-language, user-facing purpose shown in cards and the workspace header.
const AGENT_PURPOSE = {
  scholar: "Explore and discuss research papers, with answers grounded in sources.",
  anvil: "Design neuro-symbolic architectures and generate diagrams for Tool4Boxology.",
  cartographer: "Explore knowledge-graph relationships and the evidence behind them.",
};
const AGENT_ACTION = { scholar: "Explore papers", anvil: "Design a system", cartographer: "Explore a graph" };
const AGENT_NAMES = { scholar: "Scholar", anvil: "Boxologist", cartographer: "Cartographer" };
// Each starter is { label, prompt }: the button shows the short label but
// drops the full prompt into the composer (some prompts, e.g. the Bekkum
// design-pattern brief, are long).
const STARTERS = {
  scholar: [
    { label: "Explain fuzzy systems", prompt: "Explain me fuzzy systems." },
    { label: "Neural systems in the medical domain", prompt: "Tell me about neural systems in the medical domain." },
  ],
  anvil: [
    { label: "Chest X-ray pneumonia → treatment guidelines",
      prompt: "We have a lot of chest X-ray images that doctors should label first. Then we want to train a model to detect pneumonia. Later, we want to combine the model's predictions with medical guidelines to suggest possible treatments." },
    { label: "Bekkum et al. NeSy design-pattern boxology",
      prompt: "#NeSy System Description# A standard machine learning system is trained (generate:train) to construct a model which is then applied to input data in order to produce (infer:deduce) a prediction (for example, a label for a given input image).\nThe result of this process (in the form of the pairs of image + label) is then passed on to a symbolic reasoning system\nwhich then uses background knowledge (model:semantic) to produce a “rational reconstruction” of a reason to justify\nthe input/output-pair of the learning system.\n#INSTRUCTIONS# Generate the boxology of design patterns following Bekkum et al. Boxology." },
  ],
  cartographer: [
    // Favor multi-hop questions over flat "list every X" ones -- these make
    // Cartographer write a query with real joins (hasInput/hasProcess/...),
    // which is what turns the graph into a labeled, connected walk instead
    // of a handful of same-type dots with nothing to link them. Kept in sync
    // with cartographer.py's own WORKED EXAMPLES -- same 4 questions, so a
    // starter chip always demonstrates a query the system prompt actually
    // covers (no more Rule/grade/SHACL questions here -- that schema was
    // deliberately removed from Cartographer's scope, see cartographer.py).
    { label: "Patterns in the VANILLA boxology", prompt: "Find all patterns in the VANILLA boxology." },
    { label: "Patterns whose output is a Model", prompt: "Find patterns whose output is a Model." },
    { label: "Kautz Neuro → Symbolic pattern", prompt: "Find a Kautz Neuro-Symbolic pattern -- a Deduce process that takes a neural model as one of its two inputs." },
    { label: "Elementary pattern: Data + Model → Model", prompt: "Find elementary patterns that infer a Model from Data and a Model." },
  ],
};

let currentAgent = "scholar";
let history = [];
let graphNodes = [];
let graphLinks = [];
let fg = null; // the force-graph instance backing #graph-canvas
const agentSessions = {};
let selectedNodeId = null;
const expandedNodeIds = new Set();
let hoveredNodeId = null;
let lastSparqlQuery = ""; // literal text of the most recent SPARQL query, for edge labeling
let lastGraphAutoFit = 0;
let graphNavStack = []; // ids of nodes the researcher has manually visited, for the breadcrumb/back-forward trail
let graphNavIndex = -1;
let graphEntryClasses = null; // cached /api/sparql/schema result for the home/entry view (null = not fetched yet)
let graphSearchDebounce = null;
let lastQueryResult = null; // {vars, rows} of the Query tab's last run, for Show-on-graph/CSV/JSON export
let queryHistoryList = [];
let lastSemanticFile = null; // most recent Boxologist plan's semantic_file, for "My projects" artifact capture

// --- Navigation / router -----------------------------------------------------
//
// Multi-view SPA: the sidebar nav and in-page links carry data-view; navigate()
// shows the matching <section class="view">. "design" (the diagram editor) and
// "assistants" (the workspace) are views too, reached both from the nav and
// programmatically (editor openEditor() -> setMode("design")).

const VIEWS = {
  overview: { el: "view-overview", label: "Overview" },
  assistants: { el: "chat-view", label: "AI assistants" },
  projects: { el: "view-projects", label: "My projects" },
  templates: { el: "view-templates", label: "Templates" },
  "getting-started": { el: "view-getting-started", label: "Getting started" },
  design: { el: "design-view", label: "Diagram editor" },
};
let currentView = "overview";

function navigate(view) {
  if (!VIEWS[view]) return;
  currentView = view;
  for (const [name, def] of Object.entries(VIEWS)) {
    document.getElementById(def.el).classList.toggle("visible", name === view);
  }
  document.querySelectorAll(".nav-item[data-view]").forEach((n) =>
    n.classList.toggle("active", n.dataset.view === view));
  const bc = document.querySelector(".breadcrumb");
  if (bc) bc.textContent = "/ " + VIEWS[view].label;
  if (view === "overview") renderOverview();
  if (view === "projects") renderProjects();
  if (view === "templates") renderTemplates();
  if (view === "getting-started") renderGuide();
  if (view === "design") loadDesignView();
  closeSidebar();
  window.scrollTo(0, 0);
}

// Back-compat shim: editor.js and the maximize dialog call setMode().
function setMode(mode) {
  navigate(mode === "design" ? "design" : "assistants");
}

// data-view links/buttons anywhere in the page drive navigation. The "About
// the studio" nav is a real <a href> with no data-view, so it loads about.html.
document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-view]");
  if (!trigger) return;
  event.preventDefault();
  navigate(trigger.dataset.view);
});

// --- Mobile sidebar ---------------------------------------------------------
const sidebarEl = document.getElementById("sidebar");
const sidebarScrim = document.getElementById("sidebar-scrim");
const menuToggle = document.getElementById("mobile-menu-toggle");
function openSidebar() { sidebarEl.classList.add("open"); sidebarScrim.hidden = false; menuToggle.setAttribute("aria-expanded", "true"); }
function closeSidebar() { sidebarEl.classList.remove("open"); sidebarScrim.hidden = true; menuToggle.setAttribute("aria-expanded", "false"); }
menuToggle.addEventListener("click", () => sidebarEl.classList.contains("open") ? closeSidebar() : openSidebar());
sidebarScrim.addEventListener("click", closeSidebar);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sidebarEl.classList.contains("open")) closeSidebar(); });

// --- New project ------------------------------------------------------------
let currentProjectId = null;
function newProject() {
  currentProjectId = null;
  document.getElementById("project-title").textContent = "Untitled session";
  Object.keys(agentSessions).forEach((k) => delete agentSessions[k]);
  history = [];
  messagesEl.replaceChildren();
  renderWelcome();
  resetGraph();
  resetBoxologyPreview();
  navigate("assistants");
  input.focus();
}
["new-project-top", "new-project-hero", "new-project-projects"].forEach((id) => {
  document.getElementById(id)?.addEventListener("click", newProject);
});

function loadDesignView() {
  // The in-app editor (editor.js) -- opens pre-loaded with whatever diagram
  // is currently in editorDiagram (set from the most recent "plan" SSE event
  // or an explicit "Open in editor" click) rather than always starting
  // blank. "Open in Tool4Boxology ↗" stays available as a separate link for
  // full external editing in the canonical product.
  renderEditor();
}

// --- Agent tabs --------------------------------------------------------------

function switchAgent(agent, force, skipSnapshot) {
  if (!AGENT_NAMES[agent]) return;
  if (!force && (agent === currentAgent || sendBtn.disabled)) return;
  // A maximized graph panel is fixed-positioned above everything else
  // (style.css's .maximized); switching away from Cartographer sets its
  // display:none right below, which would otherwise leave the dark scrim
  // covering the whole page with nothing visible inside it.
  closeGraphMaximize();
  if (!skipSnapshot) agentSessions[currentAgent] = { history, nodes: Array.from(messagesEl.childNodes) };
  document.querySelectorAll(".agent-tabs button[data-agent]").forEach((b) => {
    const selected = b.dataset.agent === agent;
    b.classList.toggle("active", selected);
    b.setAttribute("aria-pressed", String(selected));
  });
  currentAgent = agent;
  document.getElementById("agent-name").textContent = AGENT_NAMES[currentAgent];
  const avatar = document.getElementById("agent-avatar");
  avatar.className = "avatar " + currentAgent;
  document.getElementById("agent-desc").textContent = AGENT_PURPOSE[currentAgent];
  document.getElementById("graph-panel").style.display = currentAgent === "cartographer" ? "flex" : "none";
  document.getElementById("boxology-panel").style.display = currentAgent === "anvil" ? "flex" : "none";
  document.getElementById("anvil-model-picker").classList.toggle("hidden", currentAgent !== "anvil");
  // "Save output" (the conversation text) is available for every agent, in
  // both chat and call mode, the same way -- Boxologist additionally gets
  // its own dedicated .boxology/semantic-JSON/PNG downloads in its panel
  // (see renderBoxologyPlan() below), but that's extra, not a substitute.
  document.getElementById("save-output")?.classList.remove("hidden");
  // Output tab + resizer only apply to agents with an output panel.
  const hasOutput = currentAgent !== "scholar";
  document.getElementById("mtab-output").style.display = hasOutput ? "" : "none";
  document.getElementById("panel-resizer").style.display = hasOutput ? "" : "none";
  const outPanel = document.getElementById(currentAgent === "anvil" ? "boxology-panel" : "graph-panel");
  if (outPanel) outPanel.style.width = ""; // reset any prior resize
  showMobilePane("chat");
  const session = agentSessions[currentAgent];
  messagesEl.replaceChildren(...(session?.nodes || []));
  history = session?.history || [];
  if (!session) renderWelcome();
  input.placeholder = "Ask " + AGENT_NAMES[currentAgent] + " a question…";
  updateCallButton();
  setCallStatus("");
  resetGraph();
  resetBoxologyPreview();
  if (currentAgent === "anvil") startAnvilStatus(); else stopAnvilStatus();
}

document.querySelectorAll(".agent-tabs button[data-agent]").forEach((btn) => {
  btn.addEventListener("click", () => switchAgent(btn.dataset.agent));
});

// --- Anvil GPU readiness badge ----------------------------------------------
//
// Anvil runs on a scale-to-zero Modal GPU, so the first prompt after an idle
// pause has to wait out a ~2-3 min cold start (container boot + vLLM engine +
// LoRA adapters). The chat itself now rides that out instead of erroring, but
// the user still wants to know *before* prompting whether it's warm. While the
// Anvil tab is open we poll /api/anvil/status -- which also nudges a cold
// container to start booting -- and reflect it in the badge. Poll fast while
// warming, slow once ready (each poll resets the GPU's idle timer, keeping it
// warm while the user is actively on the tab).
let anvilStatusActive = false;
const ANVIL_STATUS_LABELS = {
  ready: "GPU ready — go ahead",
  loading: "Warming up GPU… (~2 min)",
  starting: "Waking GPU… (~2 min)",
};
function setAnvilStatus(state) {
  const badge = document.getElementById("anvil-status");
  if (!badge) return;
  badge.className = "anvil-status " + state;
  const label = badge.querySelector(".anvil-status-label");
  if (label) label.textContent = ANVIL_STATUS_LABELS[state] || "Checking GPU…";
}
let anvilStatusTimer = null; // single handle so polls can never overlap
function scheduleAnvilTick(ms) {
  clearTimeout(anvilStatusTimer);
  anvilStatusTimer = setTimeout(anvilStatusTick, ms);
}
async function anvilStatusTick() {
  clearTimeout(anvilStatusTimer); // cancel any pending tick -- only one in flight
  if (!anvilStatusActive) return;
  // Don't poll a hidden tab -- otherwise a workspace left open in a background
  // tab keeps pinging the GPU forever (and would keep it from scaling down).
  if (document.hidden) { scheduleAnvilTick(5000); return; }
  let ready = false;
  try {
    const res = await fetch("/api/anvil/status");
    const data = await res.json();
    ready = !!data.ready;
    setAnvilStatus(ready ? "ready" : (data.state === "starting" ? "starting" : "loading"));
  } catch {
    setAnvilStatus("starting");
  }
  if (!anvilStatusActive) return;
  scheduleAnvilTick(ready ? 20000 : 4000);
}
// Resume promptly when the user comes back to the tab rather than waiting out
// the current (possibly 20s) interval.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && anvilStatusActive && currentAgent === "anvil") anvilStatusTick();
});
function startAnvilStatus() {
  if (anvilStatusActive) return;
  anvilStatusActive = true;
  setAnvilStatus("starting");
  anvilStatusTick();
}
function stopAnvilStatus() { anvilStatusActive = false; clearTimeout(anvilStatusTimer); }

// --- Chat --------------------------------------------------------------------

const messagesEl = document.getElementById("messages");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");

function renderWelcome() {
  const welcome = document.createElement("div");
  welcome.className = "welcome";
  welcome.innerHTML = '<div class="welcome-symbol" aria-hidden="true">✧</div><h3>Where would you like to begin?</h3><p></p><div class="suggestions"></div>';
  welcome.querySelector("p").textContent = AGENT_DESCRIPTIONS[currentAgent] + " Start with a question or talk out loud.";
  for (const starter of STARTERS[currentAgent]) {
    const button = document.createElement("button");
    button.textContent = starter.label + " ↗";
    button.title = starter.prompt;
    // The composer is a single-line input (it strips newlines, which would
    // merge words across line breaks), so collapse any newlines to spaces.
    button.addEventListener("click", () => { input.value = starter.prompt.replace(/\s*\n\s*/g, " "); input.focus(); });
    welcome.querySelector(".suggestions").appendChild(button);
  }
  messagesEl.appendChild(welcome);
}
renderWelcome();

sendBtn.addEventListener("click", sendMessage);
input.addEventListener("keydown", (e) => { if (e.key === "Enter") sendMessage(); });

// --- Citation detail: click a source chip or an inline [n] in the answer ----

function googleSearchUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

// Wraps query terms that actually occur on the cited page in <mark> so the
// user can see at a glance *why* this excerpt matched, not just read a block
// of text -- the text is escaped first so page content can't inject markup.
function highlightTerms(text, terms) {
  const escaped = escapeHtml(text);
  if (!terms || !terms.length) return escaped;
  const pattern = terms.map((t) => t.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")).join("|");
  return escaped.replace(new RegExp(`\\b(${pattern})\\b`, "gi"), "<mark>$1</mark>");
}

let citeModalToastTimer = null;
function showCiteModalToast(message) {
  const toast = document.getElementById("cite-modal-toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(citeModalToastTimer);
  citeModalToastTimer = setTimeout(() => toast.classList.remove("show"), 1600);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showCiteModalToast("Copied to clipboard");
  } catch {
    showCiteModalToast("Couldn't copy -- select and copy manually");
  }
}

let currentCiteSource = null;

function openCiteModal(source) {
  currentCiteSource = source;
  document.getElementById("cite-modal-badge").textContent =
    typeof source.relevance === "number" ? `${source.relevance}% match` : "";
  document.getElementById("cite-modal-title").textContent = source.doc_title;

  const authorsEl = document.getElementById("cite-modal-authors");
  authorsEl.textContent = source.authors || "";
  authorsEl.classList.toggle("hidden", !source.authors);

  document.getElementById("cite-modal-meta").textContent = `Page ${source.page_no}`;

  const doiField = document.getElementById("cite-modal-doi-field");
  const doiLink = document.getElementById("cite-modal-doi-link");
  if (source.doi) {
    doiLink.textContent = source.doi;
    doiLink.href = `https://doi.org/${encodeURIComponent(source.doi)}`;
    doiField.classList.remove("hidden");
  } else {
    doiField.classList.add("hidden");
  }

  document.querySelector('[data-search="title"]').href = googleSearchUrl(source.doc_title);
  const doiSearchLink = document.querySelector('[data-search="doi"]');
  doiSearchLink.href = source.doi ? googleSearchUrl(source.doi) : "#";
  doiSearchLink.classList.toggle("hidden", !source.doi);

  const termsEl = document.getElementById("cite-modal-terms");
  if (source.matched_terms && source.matched_terms.length) {
    termsEl.innerHTML = source.matched_terms
      .map((t) => `<span class="cite-term-chip">${escapeHtml(t)}</span>`).join("");
    termsEl.classList.remove("hidden");
  } else {
    termsEl.classList.add("hidden");
  }

  const excerpt = source.summary || source.snippet || "No excerpt available.";
  document.getElementById("cite-modal-snippet").innerHTML = highlightTerms(excerpt, source.matched_terms);

  document.getElementById("cite-modal").showModal();
}
document.getElementById("cite-modal-close").addEventListener("click", () => document.getElementById("cite-modal").close());
document.addEventListener("click", (e) => {
  const target = e.target.closest("[data-citation]");
  if (!target) return;
  const source = target.closest(".msg.assistant")?._citations?.[Number(target.dataset.citation)];
  if (source) openCiteModal(source);
});
document.querySelectorAll("#cite-modal [data-copy]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!currentCiteSource) return;
    const text = btn.dataset.copy === "doi" ? currentCiteSource.doi : currentCiteSource.doc_title;
    if (text) copyToClipboard(text);
  });
});

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="msg-text"></div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text || sendBtn.disabled) return;
  messagesEl.querySelector(".welcome")?.remove();
  input.value = "";
  sendBtn.disabled = true;
  addMessage("user", text).querySelector(".msg-text").textContent = text;
  history.push({ role: "user", content: text });

  const assistantDiv = addMessage("assistant", "");
  const textEl = assistantDiv.querySelector(".msg-text");
  textEl.innerHTML = '<span class="typing-dots" aria-label="Assistant is thinking"><i></i><i></i><i></i></span>';
  let sourcesEl = null;
  let fullText = "";

  // The stepper (resetStepper(), desk.js) now carries the question text
  // itself (shared with the call desk's identical stepper) -- no separate
  // floating question bubble needed for chat. Guarded by !deskActive for the
  // same reason as handleEvent's hop/query cases below: don't let a text
  // question touch the call's stepper if a call is somehow active.
  if (currentAgent === "cartographer") { resetGraph(); if (!deskActive) resetStepper(text); }
  if (currentAgent === "anvil") resetBoxologyPreview();

  try {
    const body = { message: text, history: history.slice(0, -1) };
    if (currentAgent === "anvil") body.model = document.getElementById("anvil-model").value;
    const response = await fetch(`/api/chat/${currentAgent}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("The assistant could not respond. Please try again.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop();
      for (const part of parts) {
        if (!part.startsWith("data:")) continue;
        const event = JSON.parse(part.slice(5).trim());
        handleEvent(event, textEl, assistantDiv, (s) => { sourcesEl = s; }, () => sourcesEl, (t) => { fullText += t; });
      }
    }
  } catch (err) {
    textEl.innerHTML = "";
    textEl.textContent = `Error: ${err}`;
    textEl.classList.add("msg-error");
  }

  history.push({ role: "assistant", content: fullText });
  sendBtn.disabled = false;
  input.focus();
}

function handleEvent(event, textEl, container, setSourcesEl, getSourcesEl, appendText) {
  switch (event.type) {
    case "text":
      textEl.dataset.raw = (textEl.dataset.raw || "") + event.text;
      textEl.innerHTML = renderMarkdown(textEl.dataset.raw);
      linkifyCitations(textEl, container._citations);
      appendText(event.text);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      break;
    case "tool_call":
      appendNote(container, event.query ? `Searching: "${event.query}"` : "Generating diagram…");
      break;
    case "sources": {
      let el = getSourcesEl();
      if (!el) {
        el = document.createElement("div");
        el.className = "sources";
        container.appendChild(el);
        setSourcesEl(el);
      }
      container._citations = container._citations || {};
      for (const s of event.sources) {
        container._citations[s.citation] = s;
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "source-chip";
        chip.dataset.citation = String(s.citation);
        chip.append(`[${s.citation}] ${s.doc_title} p.${s.page_no}`);
        if (typeof s.relevance === "number") {
          const score = document.createElement("b");
          score.className = "source-chip-score";
          score.textContent = ` · ${s.relevance}% match`;
          chip.appendChild(score);
        }
        chip.title = "Click for details";
        el.appendChild(chip);
      }
      break;
    }
    case "hop": {
      // Drives the same LINK/READ/RANK/WALK/SELECT stepper the call desk
      // shows (desk.js, loaded after this file but global by the time any
      // event streams in) -- so a text-chat question narrates the pre-query
      // semantic match/rank stage too, not just the SPARQL query itself.
      // Guarded by !deskActive: "Talk to Cartographer" isn't gated on a
      // still-streaming text reply, so a stray late hop/query/query_result
      // event from that old stream must not touch the call's own stepper
      // once a call has actually started.
      const step = hopStageToStep(event.stage);
      if (step && !deskActive) advanceStepper(step);
      break;
    }
    case "query":
      lastSparqlQuery = event.query || "";
      if (!deskActive) advanceStepper("READ");
      appendNote(container, event.query, false, true);
      break;
    case "query_result":
      if (event.error) {
        appendNote(container, `Query error: ${event.error}`, true);
        document.getElementById("query-error").textContent = event.error;
        document.getElementById("query-error").classList.remove("hidden");
        break;
      }
      if (!deskActive) advanceStepper("SELECT");
      appendNote(container, `${event.rows.length} row(s) returned.`);
      // Mirrors into the Query tab too (editor text + results table), so
      // switching tabs shows the agent's own query/rows, not just the graph
      // built from them -- one tab for "see result" either way, not a
      // separate window duplicating the same data (see desk.js's identical
      // call-path wiring).
      presentQueryResult(lastSparqlQuery, event.vars, event.rows, `${event.rows.length} row(s) — from Cartographer's own query`);
      ingestSparqlResult(event.vars, event.rows);
      break;
    case "plan":
      editorDiagram = event.boxology_file || null;
      lastSemanticFile = event.semantic_file || null;
      renderPlanChip(container, event);
      renderBoxologyPlan(event);
      break;
    case "error":
      appendNote(container, `Error: ${event.message}`, true);
      break;
    case "done":
      break;
  }
}

function appendNote(container, text, isError, isQuery) {
  const note = document.createElement("div");
  note.className = isQuery ? "hops sparql-note" : "hops";
  if (isError) note.style.color = "var(--bad)";
  note.textContent = text;
  container.appendChild(note);
}

// --- Graph-walk visualization (Cartographer) ---------------------------------
//
// Built directly from SPARQL query_result rows: every URI-valued binding in a
// row becomes a node (classified by its URI path segment -- Boxology/Rule/
// DesignPattern/Component), star-linked within that row. Nodes carry no
// permanent on-canvas label -- with a few dozen nodes on screen at once,
// always-on text collides badly, so labels only ever appear in the hover
// tooltip or the click-to-pin detail panel. Clicking a node calls
// /api/sparql/node, the same one-hop expansion the backend's own expand tool
// uses, so a user can keep walking the graph by hand, not just watch the
// agent do it.

const KIND_LABELS = { rule: "Structural rule", boxology: "Boxology diagram",
  pattern: "Design pattern", component: "Component" };

function localName(uri) {
  const text = String(uri || "");
  return text.includes("/") ? text.slice(text.lastIndexOf("/") + 1) : text;
}

// Predicates can come back as rdf:/rdfs: URIs (e.g. ".../22-rdf-syntax-ns#type"),
// where localName()'s slash-only split leaves the "#"-local part stuck on --
// split on both separators so edge labels read "type", not "...ns#type".
function localPredicateName(uri) {
  const text = String(uri || "");
  const parts = text.split(/[/#]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : text;
}

function classifyUri(uri) {
  const text = String(uri || "");
  if (text.includes("/Rule/")) return "rule";
  if (text.includes("/Boxology/") || text.includes("/Example/")) return "boxology";
  if (text.includes("/DesignPattern/")) return "pattern";
  return "component";
}

function updateGraphEmptyState() {
  document.getElementById("graph-empty").classList.toggle("hidden", graphNodes.length > 0);
}

function shortRuleLabel(ruleText) {
  const match = /type\s+(\w+)\s*\.?$/.exec(ruleText || "");
  if (match) return "→ type " + match[1];
  return !ruleText ? "" : ruleText.length > 42 ? ruleText.slice(0, 41) + "…" : ruleText;
}

function findGraphNode(id) {
  return graphNodes.find((n) => n.id === id);
}

function endpointId(ref) {
  return typeof ref === "string" ? ref : ref.id;
}

function upsertGraphNode(id, label, kind, extra = {}) {
  let node = findGraphNode(id);
  if (!node) {
    node = { id, label: label || id, kind, ...extra };
    graphNodes.push(node);
    return node;
  }
  Object.assign(node, extra);
  if (label) node.label = label;
  return node;
}

function upsertGraphLink(sourceId, targetId, label = "") {
  if (sourceId === targetId) return;
  const existing = graphLinks.find((l) => {
    const s = endpointId(l.source), t = endpointId(l.target);
    return (s === sourceId && t === targetId) || (s === targetId && t === sourceId);
  });
  if (existing) { if (label && !existing.label) existing.label = label; return; }
  graphLinks.push({ source: sourceId, target: targetId, label });
}

let walkToken = 0;

function setWalkStatus(text) {
  const el = document.getElementById("graph-walk-status");
  el.textContent = text;
  el.classList.remove("hidden");
}

function hideWalkStatus() {
  document.getElementById("graph-walk-status").classList.add("hidden");
}

// A row's own label-ish literal binding wins (any var whose name contains
// "label"); otherwise fall back to the URI's last path segment.
function sparqlRowLabel(uri, row) {
  for (const [key, binding] of Object.entries(row)) {
    if (binding.type === "literal" && /label/i.test(key)) return binding.value;
  }
  return localName(uri);
}

// Best-effort extraction of {subjectVar, predicate, objectVar} triples from
// the literal SPARQL text Cartographer just ran, so a same-row connection in
// the graph can be labeled with the real relationship (e.g. "hasInput")
// instead of an arbitrary star -- this is how the T4B papers themselves show
// a query-result graph (pattern -hasInput-> input, not just "pattern near
// input"). Deliberately tolerant: anything it can't confidently parse
// (OPTIONAL blocks, property paths) is simply skipped, and the caller falls
// back to an unlabeled connection for pairs it finds nothing for.
function parseQueryEdges(queryText) {
  const edges = [];
  if (!queryText) return edges;
  const prefixes = {};
  for (const m of queryText.matchAll(/PREFIX\s+(\w*):\s*<([^>]+)>/gi)) prefixes[m[1]] = m[2];
  const predicateLabel = (term) => {
    const pm = /^(\w+):(\w+)$/.exec(term);
    if (pm && prefixes[pm[1]] !== undefined) return pm[2];
    const um = /^<([^>]+)>$/.exec(term);
    if (um) return um[1].split(/[/#]/).filter(Boolean).pop() || um[1];
    return term;
  };
  const whereMatch = /\bWHERE\s*\{([\s\S]*)\}/i.exec(queryText);
  const body = (whereMatch ? whereMatch[1] : queryText).replace(/FILTER\s*\([^)]*\)/gi, " ");
  const tokens = body.match(/\?[A-Za-z_]\w*|<[^>\s]+>|a\b|[A-Za-z_]\w*:[\w-]+|[.;,]/g) || [];
  let subject = null, predicate = null, slot = 0; // 0=subject,1=predicate,2=object,3=between statements
  for (const tok of tokens) {
    if (tok === ".") { subject = null; predicate = null; slot = 0; continue; }
    if (tok === ";") { predicate = null; slot = 1; continue; }
    if (tok === ",") { slot = 2; continue; }
    if (slot === 0) { subject = tok; slot = 1; continue; }
    if (slot === 1) { predicate = tok; slot = 2; continue; }
    if (slot === 2) {
      if (subject && predicate && subject[0] === "?" && tok[0] === "?") {
        edges.push({ a: subject, b: tok, label: predicate === "a" ? "type" : predicateLabel(predicate) });
      }
      slot = 3; // expect '.'/';'/',' before anything else makes sense
      continue;
    }
    subject = tok; predicate = null; slot = 1; // stray token without a delimiter -- restart as a fresh subject
  }
  return edges;
}

function edgeLabelFor(queryEdges, varA, varB) {
  const a = "?" + varA, b = "?" + varB;
  for (const e of queryEdges) {
    if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return e.label;
  }
  return null;
}

// Staged reveal, not an instant dump of every node -- each row's nodes appear
// with a short pause, narrated in #graph-walk-status, so it reads as the
// agent walking the graph rather than a static result. walkToken guards
// against two queries overlapping if a second one starts before the first's
// reveal finishes.
async function ingestSparqlResult(varsList, rows) {
  const token = ++walkToken;
  setPanelExpanded("graph-panel", "graph-expand-toggle", true);

  // A query that only ever SELECTs literals (e.g. SELECT DISTINCT ?label)
  // carries no entity identity at all -- there is no real edge to draw
  // between row 1's label and row 2's label, just two unrelated strings
  // that happen to share a column. Below, drawing one anyway used to fall
  // back to resolving each label to *some* entity with that text and
  // graphing whatever it's connected to -- misleading when that label
  // isn't unique (several different patterns can share a phase name like
  // "Rule Generation"), and for more than a handful of rows it was just a
  // scatter of disconnected dots with no story. The Query results table
  // already lists every row correctly; past a few rows, that's the right
  // place for a flat list, not a graph with nothing to traverse.
  const isLiteralOnly = rows.every((row) => Object.values(row).every((b) => b.type !== "uri"));
  const FLAT_LIST_CUTOFF = 8;
  if (isLiteralOnly && rows.length > FLAT_LIST_CUTOFF) {
    graphNodes = []; graphLinks = [];
    selectedNodeId = null; expandedNodeIds.clear();
    hideGraphDetail(); hideGraphTooltip(); updateGraphEmptyState();
    drawGraph();
    setWalkStatus(`${rows.length} distinct value(s) returned, with no entity relationships between them -- see Query results for the list.`);
    updateCitedCount();
    setTimeout(() => { if (token === walkToken) hideWalkStatus(); }, 4000);
    return;
  }

  setWalkStatus(`Walking the graph — ${rows.length} matching row(s) found…`);
  // Cap the number of rows drawn so a broad SELECT (hundreds of labels)
  // doesn't turn the canvas into an unreadable hairball; the Query results
  // window still lists every row.
  const MAX_GRAPH_ROWS = 40;
  const graphRows = rows.slice(0, MAX_GRAPH_ROWS);
  const fast = rows.length > 20;
  const seedIds = [];
  const queryEdges = parseQueryEdges(lastSparqlQuery);
  for (const row of graphRows) {
    if (token !== walkToken) return;
    const uriVars = Object.entries(row).filter(([, b]) => b.type === "uri");
    let lastLabel = "";
    if (uriVars.length) {
      for (const [, binding] of uriVars) {
        const uri = binding.value;
        const kind = classifyUri(uri);
        const label = sparqlRowLabel(uri, row);
        lastLabel = label;
        const extra = {};
        if (kind === "rule" && row.body && row.head) {
          extra.fullText = `If ${row.body.value}, then ${row.head.value}.`;
        }
        upsertGraphNode(uri, label, kind, extra);
        seedIds.push(uri);
      }
      // Connect only the pairs the query itself actually joins (e.g. ?pattern
      // t4b:hasInput ?input), labeled with that real predicate; only fall
      // back to an unlabeled same-row chain when the parser found no real
      // join at all, so the graph never goes back to fully disconnected dots.
      let linkedAny = false;
      for (let i = 0; i < uriVars.length; i++) {
        for (let j = i + 1; j < uriVars.length; j++) {
          const label = edgeLabelFor(queryEdges, uriVars[i][0], uriVars[j][0]);
          if (label !== null) { upsertGraphLink(uriVars[i][1].value, uriVars[j][1].value, label); linkedAny = true; }
        }
      }
      if (!linkedAny && uriVars.length > 1) {
        for (let i = 1; i < uriVars.length; i++) upsertGraphLink(uriVars[0][1].value, uriVars[i][1].value, "");
      }
    } else {
      // Literal-only row (e.g. SELECT DISTINCT ?label): there's no URI to map,
      // so graph the label itself -- otherwise the Knowledge Graph stays empty
      // even though the Query results table is full. Prefer a label/name/title
      // binding, else the first column. A bare aggregate (COUNT/SUM/...) isn't
      // a graph entity at all, so it's left off the canvas entirely.
      const entry = Object.entries(row).find(([k]) => /label|name|title/i.test(k)) || Object.entries(row)[0];
      const isAggregate = entry && /^(count|sum|avg|min|max|total|cnt)$/i.test(entry[0]);
      const value = entry && entry[1] && entry[1].value;
      if (value && !isAggregate) { lastLabel = value; upsertGraphNode("lit:" + value, value, "entity", {}); seedIds.push("lit:" + value); }
    }
    if (!lastLabel) continue;
    drawGraph();
    setWalkStatus(`Found: ${lastLabel}`);
    await sleep(fast ? 55 : 200);
  }
  if (token !== walkToken) return;

  // Auto-reveal neighbors for a handful of the found nodes so the graph shows
  // how they relate, instead of leaving isolated dots. Each is capped so the
  // canvas stays readable; the user can still click any node for more.
  const toExpand = seedIds.slice(0, 8);
  if (toExpand.length) setWalkStatus("Linking neighbors…");
  for (const id of toExpand) {
    if (token !== walkToken) return;
    await expandGraphNode(id, null, { silent: true, maxNeighbors: 5 });
    await sleep(40);
  }
  if (token !== walkToken) return;
  const more = rows.length > MAX_GRAPH_ROWS ? ` (showing first ${MAX_GRAPH_ROWS} on the graph)` : "";
  setWalkStatus(`Done — ${rows.length} row(s) from the query${more}.`);
  updateCitedCount();
  setTimeout(() => { if (token === walkToken) hideWalkStatus(); }, 2500);
}

// "N rule(s) cited" chip next to the panel title, mirroring the reference
// viewer's "N statements cited" -- rules are this graph's closest analogue
// to a cited statement; fall back to a plain node count when there are none.
function updateCitedCount() {
  const el = document.getElementById("graph-cited");
  if (!el) return;
  const ruleCount = graphNodes.filter((n) => n.kind === "rule").length;
  if (ruleCount > 0) {
    el.textContent = `${ruleCount} rule${ruleCount === 1 ? "" : "s"} cited`;
    el.classList.remove("hidden");
  } else if (graphNodes.length > 0) {
    el.textContent = `${graphNodes.length} node${graphNodes.length === 1 ? "" : "s"} found`;
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

function resetGraph() {
  walkToken++; // cancel any in-flight walk animation
  hideWalkStatus();
  graphNodes = [];
  graphLinks = [];
  selectedNodeId = null;
  expandedNodeIds.clear();
  hideGraphDetail();
  hideGraphTooltip();
  updateGraphEmptyState();
  document.getElementById("graph-cited")?.classList.add("hidden");
  // Hide (not resetStepper(), which also un-hides/touches the call desk's
  // stepper card) the chat view's own stepper -- a fresh question re-shows
  // it via resetStepper() in sendMessage().
  document.getElementById("chat-stepper-card")?.classList.add("hidden");
  if (fg) { fg.graphData({ nodes: [], links: [] }); fg.zoomToFit(0); }
  graphNavStack = [];
  graphNavIndex = -1;
  renderBreadcrumbs();
  // A stale "#cartographer:node:..." deep link from the previous walk no
  // longer points at anything on this fresh canvas.
  if (location.hash.startsWith("#cartographer:")) {
    window.history.replaceState(null, "", location.pathname + location.search);
  }
  if (currentAgent === "cartographer") loadGraphEntry();
}

// --- force-graph rendering --------------------------------------------------
//
// Canvas-based force-directed graph (force-graph, the same library the
// reference Guido knowledge-graph viewer uses) instead of a hand-rolled D3/SVG
// simulation. One instance lives for the page's lifetime; drawGraph() just
// re-pushes the current graphNodes/graphLinks into it. No rule-grade
// filtering here -- the graph just shows whatever the last SPARQL query
// returned; asking a different question re-queries rather than re-filtering.

// Rule nodes get the amber "this is the cited evidence" treatment (mirrors
// the reference viewer highlighting the statement actually being cited);
// Bubble nodes sized by degree (small plain dot for a leaf, bigger labeled
// circle for a hub), colored by kind -- replaces the old fixed-size,
// always-labeled text pill, which packed every node's full label width into
// a single top-down DAG band and overlapped badly once more than a handful
// of same-level siblings landed in one query result (a 40-55-row result was
// an unreadable wall of overlapping pills, some pushed off-canvas).
const NODE_COLOR = { rule: "#e3a23a", boxology: "#c98a3e", pattern: "#9b8fe0", component: "#4fc3e4" };

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Recomputes each node's degree (within the currently-drawn subgraph) and
// flags the top few, plus up to 10 of the most-connected "rule" nodes (the
// cited evidence), as "hubs" -- hubs always show their label; everything
// else only labels on hover/select/high zoom. Re-run on every drawGraph()
// call since the visible subgraph keeps growing as the researcher expands
// nodes.
function computeDegreesAndHubs() {
  const deg = new Map();
  for (const l of graphLinks) {
    const s = endpointId(l.source), t = endpointId(l.target);
    deg.set(s, (deg.get(s) || 0) + 1);
    deg.set(t, (deg.get(t) || 0) + 1);
  }
  for (const n of graphNodes) n.__degree = deg.get(n.id) || 0;
  // A node only counts as a hub if it's meaningfully more connected than a
  // typical leaf -- without this floor, a graph with just a handful of real
  // hubs (e.g. 4 shared outputs among 50 one-off patterns) used to pad its
  // hub quota out with arbitrary degree-1 leaves, mislabeling them as hubs
  // too (and cluttering their immediate neighborhood with overlapping text).
  const maxDegree = graphNodes.reduce((m, n) => Math.max(m, n.__degree), 0);
  const hubFloor = Math.max(2, Math.ceil(maxDegree / 2));
  const ranked = [...graphNodes].sort((a, b) => b.__degree - a.__degree);
  const hubIds = new Set(ranked.filter((n) => n.__degree >= hubFloor).slice(0, 8).map((n) => n.id));
  // "rule" nodes (cited evidence) are always worth labeling too, but only up
  // to the same kind of cap as any other hub, most-connected first --
  // forcing EVERY rule node's label on regardless of count used to guarantee
  // overlap the moment a query cited more than a handful (e.g. 25 rules all
  // crowding their shared component, as in the screenshot that flagged this).
  const rules = graphNodes.filter((n) => n.kind === "rule").sort((a, b) => b.__degree - a.__degree);
  for (const n of rules.slice(0, 10)) hubIds.add(n.id);
  for (const n of graphNodes) {
    n.__hub = hubIds.has(n.id);
    // Fixed WORLD-SPACE collision radius, deliberately NOT divided by the
    // current zoom (globalScale) the way the on-screen render radius is --
    // feeding a screen-constant (1/globalScale) size into the physics
    // simulation created a runaway feedback loop: a wide layout triggers
    // zoomToFit to zoom out, which shrinks globalScale, which inflates the
    // "divide by globalScale" radius even further, spreading nodes wider
    // still and zooming out again (confirmed: nodes shot out to +-300,000
    // graph units before this fix). This radius stays constant regardless
    // of zoom, so the simulation settles instead of compounding.
    const baseR = Math.min(18, 4.5 + Math.sqrt(n.__degree) * 2.6);
    // Hubs reserve extra room for their always-on label (drawn to the node's
    // right, see drawGraphNode) -- scaled by the label's own length rather
    // than a flat bonus, since a flat value sized for a short label left long
    // ones (full pattern/boxology names) still colliding with their
    // neighbors, especially in a short/wide container like the call desk's
    // single window where hubs end up compressed into a narrower band.
    const labelLen = Math.min(28, (n.label || "").length); // drawGraphNode truncates past this
    n.__collideR = baseR + (n.__hub ? 40 + labelLen * 3.4 : 0);
  }
}

// Pairwise circle-circle separation, using each node's fixed world-space
// __collideR (computeDegreesAndHubs()) -- a hub reserves extra room for its
// always-on label; a small unlabeled leaf doesn't. force-graph's CDN bundle
// doesn't include the d3-force-collide module (checked the bundle directly),
// so this hand-rolls it. O(n^2) per tick, fine at Cartographer's graph sizes
// (capped well under a hundred by ingestSparqlResult's own MAX_GRAPH_ROWS +
// expand caps).
function nodeCollideForce(getNodes) {
  function force(alpha) {
    const nodes = getNodes();
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const ar = a.__collideR || 5;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const br = b.__collideR || 5;
        let dx = (b.x ?? 0) - (a.x ?? 0), dy = (b.y ?? 0) - (a.y ?? 0);
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist === 0) { dx = (Math.random() - 0.5) * 2; dy = (Math.random() - 0.5) * 2; dist = Math.sqrt(dx * dx + dy * dy); }
        const minDist = ar + br;
        if (dist >= minDist) continue;
        const push = (minDist - dist) * 0.5 * alpha;
        const ux = dx / dist, uy = dy / dist;
        a.vx = (a.vx || 0) - ux * push; a.vy = (a.vy || 0) - uy * push;
        b.vx = (b.vx || 0) + ux * push; b.vy = (b.vy || 0) + uy * push;
      }
    }
  }
  force.initialize = () => {};
  return force;
}

function ensureForceGraph() {
  if (fg || !window.ForceGraph) return fg;
  const container = document.getElementById("graph-canvas");
  fg = ForceGraph()(container)
    .nodeId("id")
    .backgroundColor("rgba(0,0,0,0)")
    .nodeCanvasObjectMode(() => "replace")
    .nodeCanvasObject(drawGraphNode)
    .nodePointerAreaPaint(paintGraphNodeArea)
    .linkCanvasObjectMode(() => "replace")
    .linkCanvasObject(drawGraphLink)
    .onNodeClick((node, event) => { event.stopPropagation(); navigateToNode(node.id); })
    .onNodeHover((node) => { hoveredNodeId = node ? node.id : null; if (!node) hideGraphTooltip(); })
    .onBackgroundClick(() => hideGraphDetail())
    // No dagMode: a strict top-down band layout crammed every same-level
    // sibling of a wide query result into one row with no vertical room to
    // spread into, which is exactly what caused the overlap. A plain force
    // layout lets a well-connected node become its own natural gravity well
    // (many link forces pulling toward it) -- closer to a radial "hub with
    // satellites" read without hardcoding which node is the center.
    .cooldownTicks(260)
    // The throttled zoomToFit() calls during the staged reveal (drawGraph(),
    // below) only approximate the layout mid-settle; re-fit once more once
    // the simulation actually stops so a hub's label (or a node pushed wide
    // by collision) doesn't end up clipped just outside that last snapshot.
    .onEngineStop(() => { if (fg) fg.zoomToFit(300, 60); });
  // Charge scales with node count (more nodes -> more mutual repulsion, or a
  // 50-row result would still collapse into a dense clump); link distance
  // is short since the collision force above does the real non-overlap work.
  fg.d3Force("charge").strength(() => -170 - Math.min(420, graphNodes.length * 7)).distanceMax(700);
  fg.d3Force("link").distance(55);
  fg.d3Force("collide", nodeCollideForce(() => fg.graphData().nodes));

  const wrap = document.querySelector(".graph-canvas-wrap");
  const resize = () => fg.width(wrap.clientWidth || 340).height(wrap.clientHeight || 290);
  resize();
  new ResizeObserver(resize).observe(wrap);
  // force-graph's onNodeHover doesn't carry pointer coordinates, so track the
  // currently-hovered node id there and position the tooltip off a plain
  // mousemove on the container instead.
  wrap.addEventListener("mousemove", (event) => {
    const node = hoveredNodeId != null && findGraphNode(hoveredNodeId);
    if (node) showGraphTooltip(event, node); else hideGraphTooltip();
  });
  wrap.addEventListener("mouseleave", hideGraphTooltip);
  return fg;
}

// Every node draws as a colored circle (radius ~ degree, so a hub visibly
// outweighs a leaf); its label only renders alongside it when selected,
// hovered, a hub/rule (see computeDegreesAndHubs()), or the camera is zoomed
// in enough to afford it -- the old "every node always carries its full
// label" approach was what produced a wall of overlapping text at 20+ nodes.
function drawGraphNode(node, ctx, globalScale) {
  const isSelected = node.id === selectedNodeId;
  const isHovered = node.id === hoveredNodeId;
  const baseR = Math.min(18, 4.5 + Math.sqrt(node.__degree || 0) * 2.6);
  const r = baseR / globalScale;
  node.__r = r;

  ctx.beginPath();
  ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
  ctx.fillStyle = NODE_COLOR[node.kind] || NODE_COLOR.component;
  ctx.globalAlpha = node.__hub || isSelected || isHovered ? 1 : 0.8;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = (isSelected ? 2.4 : 1) / globalScale;
  ctx.strokeStyle = isSelected ? "#ffffff" : "rgba(255,255,255,0.55)";
  ctx.stroke();

  const showLabel = isSelected || isHovered || node.__hub || globalScale > 2.2;
  if (!showLabel) return;

  const text = node.label.length > 28 ? node.label.slice(0, 27) + "…" : node.label;
  ctx.font = `${isSelected || node.__hub ? "600 " : ""}${11 / globalScale}px Inter, sans-serif`;
  const textH = 11 / globalScale;
  const textW = ctx.measureText(text).width;
  const padX = 6 / globalScale, padY = 3 / globalScale, gap = 5 / globalScale;
  const boxX = node.x + r + gap, boxY = node.y - textH / 2 - padY;
  const boxW = textW + padX * 2, boxH = textH + padY * 2;

  ctx.beginPath();
  roundRectPath(ctx, boxX, boxY, boxW, boxH, boxH / 2);
  ctx.fillStyle = "rgba(10,13,38,0.78)"; // halo so the label stays legible over the starfield/other nodes
  ctx.fill();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#eef0fb";
  ctx.fillText(text, boxX + padX, node.y);
}

function paintGraphNodeArea(node, color, ctx) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(node.x, node.y, node.__r || 6, 0, 2 * Math.PI);
  ctx.fill();
}

// Draws the line itself (force-graph's own link rendering is replaced here
// so a label can sit on it) plus the real predicate name at the midpoint
// once zoomed in enough to read it -- e.g. "pattern -hasInput-> input",
// matching how the T4B papers themselves show a SPARQL query-result graph.
function drawGraphLink(link, ctx, globalScale) {
  const source = link.source, target = link.target;
  if (typeof source !== "object" || typeof target !== "object") return;
  ctx.beginPath();
  ctx.moveTo(source.x, source.y);
  ctx.lineTo(target.x, target.y);
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 1.1 / globalScale;
  ctx.stroke();

  if (link.label && globalScale > 1.4) {
    const midX = (source.x + target.x) / 2, midY = (source.y + target.y) / 2;
    ctx.font = `${9 / globalScale}px Inter, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#aab0e0";
    ctx.fillText(link.label, midX, midY);
  }
}

function drawGraph() {
  updateGraphEmptyState();
  if (!window.ForceGraph) {
    const container = document.getElementById("graph-canvas");
    container.replaceChildren();
    const title = document.createElement("p");
    title.className = "graph-fallback-title";
    title.textContent = "Knowledge graph results";
    container.appendChild(title);
    graphNodes.slice(0, 12).forEach((node) => {
      const item = document.createElement("p");
      item.className = "graph-fallback-node";
      item.textContent = `${node.kind}: ${node.label}`;
      container.appendChild(item);
    });
    return;
  }
  computeDegreesAndHubs();
  const graph = ensureForceGraph();
  graph.graphData({ nodes: graphNodes, links: graphLinks });
  // Keep the growing graph framed as new nodes arrive, throttled so the
  // camera doesn't visibly jump on every single staged-reveal tick --
  // onEngineStop() (ensureForceGraph()) does the final, accurate fit once
  // the simulation actually settles.
  const now = Date.now();
  if (now - lastGraphAutoFit > 500) { lastGraphAutoFit = now; graph.zoomToFit(300, 50); }
}

// --- Export: the live force-graph canvas -> PNG -----------------------------
//
// force-graph draws its own <canvas> inside #graph-canvas (backgroundColor
// is transparent, see ensureForceGraph()) -- there is no separate SVG/DOM
// node per graph node to serialize, so exporting is a straight canvas copy
// with an opaque background painted first (a transparent PNG would look
// broken on a light viewer). Returns null when nothing has been drawn yet.
function graphCanvasToPngBlob() {
  const canvas = document.querySelector("#graph-canvas canvas");
  if (!canvas || !canvas.width || !canvas.height) return Promise.resolve(null);
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#13173a"; // matches .graph-canvas-wrap's dark backdrop
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  return new Promise((resolve) => out.toBlob(resolve, "image/png"));
}

async function downloadGraphPng(base) {
  const blob = await graphCanvasToPngBlob();
  if (!blob) return false;
  triggerBlobDownload(`${base}-graph.png`, blob);
  return true;
}

document.getElementById("graph-download-png")?.addEventListener("click", () => downloadGraphPng(currentAgent || "cartographer"));

// --- Graph tooltip + click-to-pin detail panel ----------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Shared by both PNG exporters below (graph canvas + Boxology diagram) and
// reused by save_output.js's bundled "Save output" export -- one place that
// knows how to turn a Blob into a browser download.
function triggerBlobDownload(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function showGraphTooltip(event, d) {
  const tip = document.getElementById("graph-tooltip");
  const label = d.kind === "rule" ? (d.fullText || d.label) : d.label;
  tip.innerHTML = `<b>${escapeHtml(label)}</b><span class="tip-meta">${KIND_LABELS[d.kind] || "Node"}</span>`;
  tip.classList.remove("hidden");
  moveGraphTooltip(event);
}

function moveGraphTooltip(event) {
  const tip = document.getElementById("graph-tooltip");
  const rect = document.querySelector(".graph-canvas-wrap").getBoundingClientRect();
  tip.style.left = (event.clientX - rect.left) + "px";
  tip.style.top = (event.clientY - rect.top - 10) + "px";
}

function hideGraphTooltip() {
  document.getElementById("graph-tooltip").classList.add("hidden");
}

function selectGraphNode(d) {
  selectedNodeId = d.id;
  renderGraphDetail(d);
}

function hideGraphDetail() {
  document.getElementById("graph-detail").classList.add("hidden");
  selectedNodeId = null;
}

// Renders into a desk Inspector window during a call, the fixed side panel
// otherwise -- graphDetailTarget() (desk.js) decides which and opens/shows
// whichever is appropriate.
function renderGraphDetail(node) {
  const body = graphDetailTarget();

  const neighborIds = graphLinks
    .filter((l) => endpointId(l.source) === node.id || endpointId(l.target) === node.id)
    .map((l) => endpointId(l.source) === node.id ? endpointId(l.target) : endpointId(l.source));
  const neighbors = neighborIds.map(findGraphNode).filter(Boolean);

  body.innerHTML = `
    <div class="graph-detail-kind">${(KIND_LABELS[node.kind] || "NODE").toUpperCase()}</div>
    <p class="graph-detail-label">${escapeHtml(node.kind === "rule" ? (node.fullText || node.label) : node.label)}</p>
    <div class="graph-detail-meta"><span>${(KIND_LABELS[node.kind] || "Node").toLowerCase()}</span></div>
    <div id="graph-detail-neighbors"></div>`;

  if (neighbors.length) {
    const ul = document.createElement("ul");
    for (const n of neighbors) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = (n.kind === "rule" ? "↳ " : "• ") + (n.kind === "rule" ? (shortRuleLabel(n.fullText || n.label) || "rule") : n.label);
      button.addEventListener("click", () => navigateToNode(n.id));
      li.appendChild(button);
      ul.appendChild(li);
    }
    body.querySelector("#graph-detail-neighbors").appendChild(ul);
  }

  if (!expandedNodeIds.has(node.id)) {
    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "graph-filter";
    expandBtn.textContent = "Expand neighbors →";
    expandBtn.addEventListener("click", () => showExpandGroups(node, expandBtn));
    body.appendChild(expandBtn);
  }
}

// describe_neighbors' shape ({outgoing:[{predicate,object,object_is_uri}],
// incoming:[{subject,predicate}]}) only turns URI-valued bindings into nodes
// -- literal objects (labels, confidences, ...) are properties, not nodes.
// The real predicate (hasInput, hasProcess, appliesTo, ...) rides along as
// each neighbor's `predicate` so the graph can label the edge instead of
// drawing an anonymous line.
function sparqlNeighbors(result) {
  const out = (result.outgoing || [])
    .filter((e) => e.object_is_uri)
    .map((e) => ({ id: e.object, label: e.object_label || localName(e.object), kind: classifyUri(e.object), predicate: localPredicateName(e.predicate) }));
  const inn = (result.incoming || [])
    .map((e) => ({ id: e.subject, label: e.subject_label || localName(e.subject), kind: classifyUri(e.subject), predicate: localPredicateName(e.predicate) }));
  return [...out, ...inn];
}

async function expandGraphNode(nodeId, triggerBtn, opts = {}) {
  if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = "Expanding…"; }
  try {
    const node = findGraphNode(nodeId);
    const isUri = /^https?:\/\//.test(nodeId);
    const isLiteral = nodeId.startsWith("lit:");
    // A literal node came from a SELECT ?label result and has no URI of its
    // own; resolve its label to the real entity server-side so it can be
    // expanded like any other node (instead of a dead-end "Could not expand").
    let url;
    if (isUri) url = `/api/sparql/node?uri=${encodeURIComponent(nodeId)}`;
    else if (isLiteral) url = `/api/sparql/node?label=${encodeURIComponent((node && node.label) || nodeId.slice(4))}`;
    else url = `/api/kg/node/${encodeURIComponent(nodeId)}`;
    const response = await fetch(url);
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || "Could not expand this node.");
    expandedNodeIds.add(nodeId);
    if (isLiteral && node && result.uri) node.uri = result.uri; // now a real entity
    const neighbors = (isUri || isLiteral) ? sparqlNeighbors(result)
      : (result.neighbors || []).map((n) => ({ id: n.id, label: n.label, kind: n.id.startsWith("r:") ? "rule" : "component", predicate: n.role }));
    const slice = opts.maxNeighbors ? neighbors.slice(0, opts.maxNeighbors) : neighbors;
    for (const neighbor of slice) {
      upsertGraphNode(neighbor.id, neighbor.label, neighbor.kind);
      upsertGraphLink(nodeId, neighbor.id, neighbor.predicate || "");
    }
    drawGraph();
    if (!opts.silent) { const current = findGraphNode(nodeId); if (current) renderGraphDetail(current); }
    return slice.length;
  } catch (err) {
    if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = "Could not expand — try again"; }
    return 0;
  }
}

document.getElementById("graph-detail-close").addEventListener("click", hideGraphDetail);

// --- Home/entry view ---------------------------------------------------------
//
// Cartographer previously left #graph-canvas/#graph-empty entirely blank
// until a question was asked -- no way to browse the graph without already
// knowing what to ask. loadGraphEntry() fetches the top classes once
// (cached in graphEntryClasses) and renders them as clickable bubbles inside
// the existing #graph-empty slot; clicking one runs a small SPARQL query for
// that class's instances through the same ingestSparqlResult() walk a real
// question would trigger.

async function loadGraphEntry() {
  if (graphEntryClasses === null) {
    try {
      const res = await fetch("/api/sparql/schema");
      const data = await res.json();
      graphEntryClasses = data.classes || [];
    } catch {
      graphEntryClasses = [];
    }
  }
  renderGraphEntry();
}

function renderGraphEntry() {
  if (graphNodes.length > 0) return; // a walk already populated the canvas since this was scheduled
  const el = document.getElementById("graph-empty");
  if (!el) return;
  if (!graphEntryClasses || !graphEntryClasses.length) {
    el.textContent = "Ask a question to start mapping the graph.";
    return;
  }
  el.replaceChildren();
  const intro = document.createElement("p");
  intro.className = "graph-entry-intro";
  intro.textContent = "Ask a question, or start from a class:";
  const wrap = document.createElement("div");
  wrap.className = "graph-entry-bubbles";
  for (const cls of graphEntryClasses) {
    const bubble = document.createElement("button");
    bubble.type = "button";
    bubble.className = "graph-entry-bubble";
    bubble.textContent = `${cls.label} (${cls.count})`;
    bubble.addEventListener("click", () => exploreClass(cls));
    wrap.appendChild(bubble);
  }
  el.append(intro, wrap);
}

async function exploreClass(cls) {
  const query = `SELECT ?s ?label WHERE { ?s a <${cls.type}> ; `
    + `<http://www.w3.org/2000/01/rdf-schema#label> ?label . } LIMIT 25`;
  lastSparqlQuery = query;
  setWalkStatus(`Loading ${cls.label}…`);
  try {
    const res = await fetch("/api/sparql", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    if (data.error) { setWalkStatus(`Could not load ${cls.label}: ${data.error}`); return; }
    await ingestSparqlResult(data.vars, data.rows);
  } catch {
    setWalkStatus(`Could not load ${cls.label} — check your connection.`);
  }
}

// --- Search -------------------------------------------------------------------
//
// Label/IRI substring search over the whole graph (not just whatever's
// currently on canvas) via /api/sparql/search, debounced so every keystroke
// doesn't fire a request.

let graphSearchToken = 0; // guards against a slower, now-stale request overwriting a faster, newer one

function graphSearchHandler(event) {
  clearTimeout(graphSearchDebounce);
  const q = event.target.value.trim();
  const results = document.getElementById("graph-search-results");
  if (!q) { graphSearchToken++; results.classList.add("hidden"); results.replaceChildren(); return; }
  graphSearchDebounce = setTimeout(() => runGraphSearch(q), 200);
}

async function runGraphSearch(q) {
  const token = ++graphSearchToken;
  try {
    const res = await fetch(`/api/sparql/search?q=${encodeURIComponent(q)}&limit=12`);
    const data = await res.json();
    if (token !== graphSearchToken) return; // a newer search started while this one was in flight
    renderGraphSearchResults(data.results || []);
  } catch {
    if (token === graphSearchToken) document.getElementById("graph-search-results").classList.add("hidden");
  }
}

function renderGraphSearchResults(items) {
  const results = document.getElementById("graph-search-results");
  results.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "graph-search-empty";
    empty.textContent = "No matches.";
    results.appendChild(empty);
    results.classList.remove("hidden");
    return;
  }
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "graph-search-result";
    btn.innerHTML = `<i class="legend-dot ${item.kind}"></i><span>${escapeHtml(item.label)}</span>`
      + `<small>${KIND_LABELS[item.kind] || item.kind}</small>`;
    btn.addEventListener("click", () => selectSearchResult(item));
    results.appendChild(btn);
  }
  results.classList.remove("hidden");
}

function selectSearchResult(item) {
  document.getElementById("graph-search-results").classList.add("hidden");
  document.getElementById("graph-search-input").value = "";
  if (!findGraphNode(item.id)) upsertGraphNode(item.id, item.label, item.kind);
  drawGraph();
  navigateToNode(item.id, { centerCamera: true });
}

document.getElementById("graph-search-input")?.addEventListener("input", graphSearchHandler);
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && currentAgent === "cartographer") {
    event.preventDefault();
    document.getElementById("graph-search-input")?.focus();
  }
  if (event.key === "Escape") document.getElementById("graph-search-results")?.classList.add("hidden");
});
document.addEventListener("click", (event) => {
  if (event.target.closest("#graph-search-input, #graph-search-results")) return;
  document.getElementById("graph-search-results")?.classList.add("hidden");
});

// --- Breadcrumb trail, back/forward, deep links -------------------------------
//
// graphNavStack/graphNavIndex track the researcher's own manual path through
// already-drawn nodes (clicks, search picks, breadcrumb/back-forward) --
// separate from the agent-driven staged "walk" animation in
// ingestSparqlResult(), which narrates itself. The current node's URI is
// mirrored into location.hash (window.history -- plain `history` here is
// the file-scoped chat-history array declared near the top of this file,
// not the browser History object) so a view can be reloaded or shared.

function navigateToNode(nodeId, opts = {}) {
  const node = findGraphNode(nodeId);
  if (!node) return;
  selectGraphNode(node);
  const hash = "#cartographer:node:" + encodeURIComponent(nodeId);
  const idx = graphNavStack.indexOf(nodeId);
  if (opts.push !== false) {
    // A brand-new manual navigation (click/search pick/neighbor pick):
    // drop any forward entries past here, then append.
    graphNavStack = graphNavStack.slice(0, graphNavIndex + 1);
    if (graphNavStack[graphNavStack.length - 1] !== nodeId) graphNavStack.push(nodeId);
    graphNavIndex = graphNavStack.length - 1;
    if (location.hash !== hash) window.history.pushState(null, "", hash);
  } else if (idx >= 0) {
    // Moving within the already-visited stack (breadcrumb chip / Back / Forward).
    graphNavIndex = idx;
    if (location.hash !== hash) window.history.replaceState(null, "", hash);
  } else {
    // A fresh destination reached without a "new navigation" step (deep-link
    // load or a popstate restore to a node never visited this session) --
    // still needs to seed the stack, or the breadcrumb trail and Back button
    // would have nothing to show, just without adding a redundant browser-
    // history entry (the browser may have just moved here itself).
    graphNavStack = [nodeId];
    graphNavIndex = 0;
    if (location.hash !== hash) window.history.replaceState(null, "", hash);
  }
  renderBreadcrumbs();
  if (opts.centerCamera && fg) { fg.centerAt(node.x, node.y, 400); fg.zoom(2.2, 400); }
}

function renderBreadcrumbs() {
  const bar = document.getElementById("graph-breadcrumbs");
  const trail = document.getElementById("graph-breadcrumb-trail");
  const back = document.getElementById("graph-nav-back");
  const fwd = document.getElementById("graph-nav-forward");
  if (!bar || !trail) return;
  if (!graphNavStack.length) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  back.disabled = graphNavIndex <= 0;
  fwd.disabled = graphNavIndex >= graphNavStack.length - 1;
  trail.replaceChildren();
  graphNavStack.forEach((id, i) => {
    if (i > 0) trail.appendChild(document.createTextNode(" › "));
    const node = findGraphNode(id);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "graph-breadcrumb-chip" + (i === graphNavIndex ? " current" : "");
    const label = node ? node.label : "?";
    chip.textContent = label.length > 18 ? label.slice(0, 17) + "…" : label;
    chip.addEventListener("click", () => { graphNavIndex = i; navigateToNode(id, { push: false }); });
    trail.appendChild(chip);
  });
}

document.getElementById("graph-nav-back")?.addEventListener("click", () => {
  if (graphNavIndex > 0) { graphNavIndex--; navigateToNode(graphNavStack[graphNavIndex], { push: false, centerCamera: true }); }
});
document.getElementById("graph-nav-forward")?.addEventListener("click", () => {
  if (graphNavIndex < graphNavStack.length - 1) { graphNavIndex++; navigateToNode(graphNavStack[graphNavIndex], { push: false, centerCamera: true }); }
});

// A node from a deep link or browser back/forward may not be on the canvas
// yet (e.g. a bookmarked link opened fresh) -- fetch just enough (its label)
// to draw it before selecting it.
async function loadAndNavigateToNode(uri) {
  try {
    const res = await fetch(`/api/sparql/node?uri=${encodeURIComponent(uri)}`);
    const data = await res.json();
    if (!res.ok || data.error) return;
    upsertGraphNode(uri, data.label, classifyUri(uri));
    drawGraph();
    await sleep(60); // let the force layout place the node before centering on it
    navigateToNode(uri, { push: false, centerCamera: true });
  } catch {
    // Deep-link target unreachable -- leave the panel on its default state
    // rather than surfacing a raw fetch error for a background restore.
  }
}

window.addEventListener("popstate", () => {
  if (currentAgent !== "cartographer") return;
  const match = /^#cartographer:node:(.+)$/.exec(location.hash);
  if (!match) return;
  const nodeId = decodeURIComponent(match[1]);
  if (findGraphNode(nodeId)) navigateToNode(nodeId, { push: false, centerCamera: true });
  else loadAndNavigateToNode(nodeId);
});

// --- Grouped-expand: per-predicate counts before dumping a hub's neighbors ---

async function showExpandGroups(node, triggerBtn) {
  triggerBtn.disabled = true;
  triggerBtn.textContent = "Checking neighbors…";
  const isUri = /^https?:\/\//.test(node.id);
  if (!isUri) { expandGraphNode(node.id, triggerBtn); return; } // literal/rule-graph nodes have no groups endpoint
  try {
    const res = await fetch(`/api/sparql/node/groups?uri=${encodeURIComponent(node.id)}`);
    const data = await res.json();
    // rdf:type edges are schema noise, not a graph relationship worth a
    // button -- every typed entity has one, and it's never what a researcher
    // means by "expand this node".
    const groups = (data.groups || []).filter((g) => g.label !== "type");
    const total = groups.reduce((n, g) => n + g.count, 0);
    if (!groups.length || total <= 6) { expandGraphNode(node.id, triggerBtn); return; }
    expandedNodeIds.add(node.id);
    renderExpandGroups(node, groups, triggerBtn);
  } catch {
    expandGraphNode(node.id, triggerBtn); // groups endpoint unreachable -- fall back to the flat expand
  }
}

function renderExpandGroups(node, groups, expandBtn) {
  const body = expandBtn.parentElement;
  expandBtn.remove();
  const label = document.createElement("p");
  label.className = "graph-detail-hint";
  label.textContent = "Expand by relationship:";
  body.appendChild(label);
  for (const group of groups) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "graph-filter";
    const arrow = group.direction === "in" ? "← " : " →";
    btn.textContent = group.direction === "in" ? `${arrow}${group.label} (${group.count})` : `${group.label}${arrow} (${group.count})`;
    btn.onclick = () => loadNeighborGroup(node.id, group, btn, btn.textContent, 0);
    body.appendChild(btn);
  }
}

async function loadNeighborGroup(nodeId, group, triggerBtn, baseLabel, offset) {
  triggerBtn.disabled = true;
  triggerBtn.textContent = "Loading…";
  try {
    const url = `/api/sparql/node/neighbors?uri=${encodeURIComponent(nodeId)}&predicate=${encodeURIComponent(group.predicate)}`
      + `&direction=${group.direction}&offset=${offset}&limit=25`;
    const res = await fetch(url);
    const data = await res.json();
    for (const item of data.items || []) {
      upsertGraphNode(item.id, item.label, item.kind);
      upsertGraphLink(nodeId, item.id, group.label);
    }
    drawGraph();
    const fetched = offset + (data.items || []).length;
    const remaining = (data.total || 0) - fetched;
    if (remaining > 0) {
      triggerBtn.disabled = false;
      triggerBtn.textContent = `${baseLabel} — show ${Math.min(25, remaining)} more`;
      triggerBtn.onclick = () => loadNeighborGroup(nodeId, group, triggerBtn, baseLabel, fetched);
    } else {
      triggerBtn.disabled = true;
      triggerBtn.textContent = `${baseLabel} ✓`;
    }
  } catch {
    triggerBtn.disabled = false;
    triggerBtn.textContent = "Could not load — try again";
    triggerBtn.onclick = () => loadNeighborGroup(nodeId, group, triggerBtn, baseLabel, offset);
  }
}

// --- Query view: a separate tab with an editable SPARQL editor ---------------

const QUERY_SAVED_EXAMPLES = [
  { label: "Patterns in the VANILLA boxology", query: `PREFIX t4b: <http://tool4boxology.org/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?pattern ?patternLabel WHERE {
  ?boxology rdfs:label "VANILLA" ;
            t4b:hasPattern ?pattern .
  ?pattern rdfs:label ?patternLabel .
} LIMIT 100` },
  { label: "Patterns whose output is a Model", query: `PREFIX t4b: <http://tool4boxology.org/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?pattern ?label ?output WHERE {
  ?pattern t4b:hasOutput ?output ;
           rdfs:label ?label .
  ?output a t4b:Model .
} LIMIT 100` },
  { label: "Every class and its instance count", query: `SELECT ?type (COUNT(?s) AS ?count) WHERE { ?s a ?type } GROUP BY ?type ORDER BY DESC(?count)` },
  { label: "Components shared by two patterns", query: `PREFIX t4b: <http://tool4boxology.org/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?p1Label ?p2Label ?componentLabel WHERE {
  ?p1 t4b:hasInput ?component ; rdfs:label ?p1Label .
  ?p2 t4b:hasInput ?component ; rdfs:label ?p2Label .
  ?component rdfs:label ?componentLabel .
  FILTER(?p1 != ?p2)
} LIMIT 50` },
  { label: "Every structural rule and the component it applies to", query: `PREFIX t4b: <http://tool4boxology.org/>
SELECT ?rule ?head ?component WHERE {
  ?rule a t4b:Rule ; t4b:head ?head ; t4b:appliesTo ?component .
} LIMIT 50` },
];

function switchGraphViewTab(tab) {
  const explore = tab === "explore";
  document.getElementById("graph-explore-view").classList.toggle("hidden", !explore);
  document.getElementById("graph-query-view").classList.toggle("hidden", explore);
  document.getElementById("graph-tab-explore").classList.toggle("active", explore);
  document.getElementById("graph-tab-explore").setAttribute("aria-selected", String(explore));
  document.getElementById("graph-tab-query").classList.toggle("active", !explore);
  document.getElementById("graph-tab-query").setAttribute("aria-selected", String(!explore));
  if (!explore) {
    const editor = document.getElementById("query-editor");
    if (!editor.value.trim() && lastSparqlQuery) editor.value = lastSparqlQuery;
  }
}
document.getElementById("graph-tab-explore")?.addEventListener("click", () => switchGraphViewTab("explore"));
document.getElementById("graph-tab-query")?.addEventListener("click", () => switchGraphViewTab("query"));

function renderQueryResultsTable(vars, rows) {
  const table = document.getElementById("query-results-table");
  const empty = document.getElementById("query-results-empty");
  if (!rows.length) {
    table.classList.add("hidden");
    empty.textContent = "No rows returned.";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  table.classList.remove("hidden");
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  thead.innerHTML = `<tr>${vars.map((v) => `<th>${escapeHtml(v)}</th>`).join("")}</tr>`;
  tbody.replaceChildren();
  for (const row of rows.slice(0, 200)) {
    const tr = document.createElement("tr");
    for (const v of vars) {
      const td = document.createElement("td");
      const binding = row[v];
      if (binding && binding.type === "uri") {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "query-uri-chip";
        chip.textContent = localName(binding.value);
        chip.title = binding.value;
        chip.addEventListener("click", () => {
          switchGraphViewTab("explore");
          loadAndNavigateToNode(binding.value);
        });
        td.appendChild(chip);
      } else if (binding) {
        td.textContent = binding.value;
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

// Shared by the Query tab's own "Run" button and Cartographer's own
// automatic queries (the agent's query_result SSE event, in both text chat
// and a live call) -- one tab, one source of truth for "what did the last
// SPARQL query actually return," whoever ran it.
function presentQueryResult(query, vars, rows, metaText) {
  lastSparqlQuery = query || lastSparqlQuery;
  if (query) document.getElementById("query-editor").value = query;
  lastQueryResult = { vars, rows };
  document.getElementById("query-meta").textContent = metaText || `${rows.length} row(s)`;
  document.getElementById("query-error").classList.add("hidden");
  renderQueryResultsTable(vars, rows);
  document.getElementById("query-show-on-graph").disabled = false;
  document.getElementById("query-export-csv").disabled = false;
  document.getElementById("query-export-json").disabled = false;
}

async function runQueryEditor() {
  const query = document.getElementById("query-editor").value.trim();
  const errorEl = document.getElementById("query-error");
  const meta = document.getElementById("query-meta");
  const runBtn = document.getElementById("query-run");
  if (!query) return;
  errorEl.classList.add("hidden");
  runBtn.disabled = true;
  const started = performance.now();
  try {
    const res = await fetch("/api/sparql", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    const elapsed = Math.round(performance.now() - started);
    if (data.error) {
      errorEl.textContent = data.error;
      errorEl.classList.remove("hidden");
      meta.textContent = "";
      lastQueryResult = null;
      document.getElementById("query-results-table").classList.add("hidden");
      document.getElementById("query-results-empty").textContent = "Query failed — see the error above.";
      document.getElementById("query-results-empty").classList.remove("hidden");
    } else {
      presentQueryResult(query, data.vars, data.rows, `${data.rows.length} row(s) in ${elapsed} ms`);
      pushQueryHistory(query);
    }
  } catch {
    errorEl.textContent = "Could not reach the server.";
    errorEl.classList.remove("hidden");
  } finally {
    runBtn.disabled = false;
    const hasResult = !!lastQueryResult;
    document.getElementById("query-show-on-graph").disabled = !hasResult;
    document.getElementById("query-export-csv").disabled = !hasResult;
    document.getElementById("query-export-json").disabled = !hasResult;
  }
}

document.getElementById("query-run")?.addEventListener("click", runQueryEditor);
document.getElementById("query-editor")?.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); runQueryEditor(); }
});

function pushQueryHistory(query) {
  queryHistoryList = queryHistoryList.filter((q) => q !== query);
  queryHistoryList.unshift(query);
  queryHistoryList = queryHistoryList.slice(0, 10);
  renderQueryHistory();
}

function renderQueryHistory() {
  const host = document.getElementById("query-history");
  if (!host) return;
  host.replaceChildren();
  for (const q of queryHistoryList) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "query-history-item";
    btn.title = q;
    btn.textContent = q.replace(/\s+/g, " ").trim();
    btn.addEventListener("click", () => { document.getElementById("query-editor").value = q; runQueryEditor(); });
    host.appendChild(btn);
  }
}

function renderSavedQueryExamples() {
  const host = document.getElementById("query-saved-examples");
  if (!host) return;
  for (const ex of QUERY_SAVED_EXAMPLES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "query-history-item";
    btn.textContent = ex.label;
    btn.addEventListener("click", () => { document.getElementById("query-editor").value = ex.query; runQueryEditor(); });
    host.appendChild(btn);
  }
}
renderSavedQueryExamples();

document.getElementById("query-show-on-graph")?.addEventListener("click", () => {
  if (!lastQueryResult) return;
  switchGraphViewTab("explore");
  lastSparqlQuery = document.getElementById("query-editor").value;
  resetGraph();
  ingestSparqlResult(lastQueryResult.vars, lastQueryResult.rows);
});
document.getElementById("query-export-csv")?.addEventListener("click", () => {
  if (!lastQueryResult) return;
  const esc = (s) => /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  const lines = [lastQueryResult.vars.map(esc).join(",")];
  for (const row of lastQueryResult.rows) {
    lines.push(lastQueryResult.vars.map((v) => esc(row[v] ? row[v].value : "")).join(","));
  }
  triggerBlobDownload("cartographer-query-results.csv", new Blob([lines.join("\n")], { type: "text/csv" }));
});
document.getElementById("query-export-json")?.addEventListener("click", () => {
  if (!lastQueryResult) return;
  triggerBlobDownload("cartographer-query-results.json",
    new Blob([JSON.stringify(lastQueryResult, null, 2)], { type: "application/json" }));
});

// --- Real Tavus video calls (Daily.co WebRTC, no iframe) ------------------------
//
// The backend call-orchestration already fully exists (tavus_bridge.start_call/
// end_call, /api/tavus/live/{id}) -- this just joins it. POST start_call gets a
// Daily room URL; window.Daily.createCallObject() joins it headlessly (no
// <iframe>, matching the reference project's pattern) and the raw MediaStream
// tracks are attached to plain <video>/<audio> elements. Tavus's own webhook
// deliveries (conversation.utterance / conversation.tool_call) arrive server-side
// and are relayed over /api/tavus/live/{id} -- the same hand-rolled SSE parser
// used for text chat, since that endpoint is a plain unauthenticated GET and
// keeping one stream-parsing code path beats having two. Desk windows (graph/
// notes/inspector/results) are driven from those same events via
// deskHandleEvent() (desk.js).

let dailyCall = null;
let activeConversationId = null;
let activeEndToken = null;
let liveEventsAbort = null;

// Minimal stroke-based icons (no emoji) for the call control bar -- each pair
// (on/off) swaps via setControlState() so the icon always reflects the real
// mute/video/chat state instead of staying static.
const CALL_ICONS = {
  micOn: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z"/><path d="M19 11a7 7 0 0 1-14 0"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>',
  micOff: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z"/><path d="M19 11a7 7 0 0 1-14 0"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/><line x1="3" y1="3" x2="21" y2="21"/></svg>',
  videoOn: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="7" width="13" height="10" rx="2"/><path d="M15.5 10.5 21 7v10l-5.5-3.5"/></svg>',
  videoOff: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="7" width="13" height="10" rx="2"/><path d="M15.5 10.5 21 7v10l-5.5-3.5"/><line x1="3" y1="3" x2="21" y2="21"/></svg>',
  chatOn: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v10H9l-4 4V5Z"/></svg>',
  chatOff: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v10H9l-4 4V5Z"/><line x1="4" y1="4" x2="20" y2="18"/></svg>',
  phoneEnd: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 15.5c-2.4 0-4.6-.5-6.6-1.4a1.7 1.7 0 0 1-1-1.6v-2a1.3 1.3 0 0 1 1-1.3c1-.2 2-.4 3-.4.5 0 .9.3 1 .8l.3 1.5c.1.5-.1 1-.5 1.3l-.6.5c.9 1.5 2.2 2.8 3.7 3.7l.5-.6c.3-.4.8-.6 1.3-.5l1.5.3c.5.1.8.5.8 1v3c0 .5-.3.9-.8 1-1.4.3-2.8.4-4.2.4Z" transform="rotate(135 12 12)"/></svg>',
};

function setIcon(buttonId, iconKey) {
  const slot = document.querySelector(`#${buttonId} .icon-slot`);
  if (slot) slot.innerHTML = CALL_ICONS[iconKey];
}

function resetCallControls() {
  const mute = document.getElementById("call-mute");
  mute.setAttribute("aria-pressed", "false");
  mute.querySelector(".btn-label").textContent = "Mute";
  setIcon("call-mute", "micOn");

  const video = document.getElementById("call-video-toggle");
  video.setAttribute("aria-pressed", "false");
  video.querySelector(".btn-label").textContent = "Stop Video";
  setIcon("call-video-toggle", "videoOn");

  const chat = document.getElementById("call-chat-toggle");
  chat.setAttribute("aria-pressed", "true");
  chat.querySelector(".btn-label").textContent = "Chat";
  setIcon("call-chat-toggle", "chatOn");
  document.getElementById("transcript-wrap").classList.remove("hidden");

  setIcon("close-voice", "phoneEnd");
}

let callTimerInterval = null;

function startCallTimer() {
  if (callTimerInterval) return; // already running (e.g. duplicate joined-meeting events)
  const el = document.getElementById("call-timer");
  const startedAt = Date.now();
  el.textContent = "00:00";
  el.classList.remove("hidden");
  callTimerInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    const m = String(Math.floor(secs / 60)).padStart(2, "0");
    const s = String(secs % 60).padStart(2, "0");
    el.textContent = `${m}:${s}`;
  }, 1000);
}

function stopCallTimer() {
  if (callTimerInterval) clearInterval(callTimerInterval);
  callTimerInterval = null;
  document.getElementById("call-timer").classList.add("hidden");
}

function updateCallButton() {
  // width/height are required here -- an <svg> with no explicit size and no
  // containing-block constraint falls back to the UA default intrinsic size
  // (300x150 CSS px), which silently blew this button up to a huge square
  // the one time this was left relying on a CSS class (.icon) that was only
  // ever scoped to .call-controls, not to this button's own context.
  document.getElementById("start-call").innerHTML =
    "Talk to " + AGENT_NAMES[currentAgent] + ' <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px;margin-left:5px;flex-shrink:0">'
    + '<rect x="2.5" y="7" width="13" height="10" rx="2"/><path d="M15.5 10.5 21 7v10l-5.5-3.5"/></svg>';
}

function setCallStatus(message, error = false) {
  const status = document.getElementById("call-status");
  status.textContent = message;
  status.classList.toggle("hidden", !message);
  status.classList.toggle("error", error);
}

function setCallModalStatus(message, error = false) {
  const status = document.getElementById("call-modal-status");
  status.textContent = message;
  status.classList.toggle("hidden", !message);
  status.classList.toggle("error", error);
}

function attachTracks(event) {
  const p = event && event.participant;
  if (!p) return;
  const videoTrack = p.tracks?.video?.persistentTrack;
  const audioTrack = p.tracks?.audio?.persistentTrack;
  if (p.local) {
    document.getElementById("local-video").srcObject = videoTrack ? new MediaStream([videoTrack]) : null;
  } else {
    document.getElementById("remote-video").srcObject = videoTrack ? new MediaStream([videoTrack]) : null;
    document.getElementById("remote-audio").srcObject = audioTrack ? new MediaStream([audioTrack]) : null;
  }
}

async function listenToLiveEvents(conversationId) {
  const controller = new AbortController();
  liveEventsAbort = controller;
  try {
    const response = await fetch(`/api/tavus/live/${conversationId}`, { signal: controller.signal });
    if (!response.ok || !response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop();
      for (const part of parts) {
        if (!part.startsWith("data:")) continue;
        const event = JSON.parse(part.slice(5).trim());
        deskHandleEvent(event);
        if (event.type === "call_ended") return;
      }
    }
  } catch (err) {
    // Aborted on purpose when the call ends (closeVoiceModal) -- not an error.
  }
}

document.getElementById("start-call").addEventListener("click", async () => {
  if (!AGENT_NAMES[currentAgent]) {
    setCallStatus("Select an assistant before starting a video conversation.", true);
    return;
  }
  if (!window.Daily) {
    setCallStatus("Video calling could not load. Check your connection and try again.", true);
    return;
  }
  document.getElementById("voice-title").textContent = "Talk with " + AGENT_NAMES[currentAgent];
  clearTranscript();
  setCallStatus("");
  resetCallControls();
  stopCallTimer();
  document.getElementById("voice-modal").showModal();
  setCallModalStatus("Connecting…");

  try {
    const response = await fetch(`/api/tavus/start_call/${currentAgent}`, { method: "POST" });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || "Could not start the call.");
    activeConversationId = result.conversation_id;
    activeEndToken = result.end_token;

    dailyCall = window.Daily.createCallObject({ subscribeToTracksAutomatically: true });
    ["participant-joined", "participant-updated", "track-started", "joined-meeting"].forEach(
      (e) => dailyCall.on(e, attachTracks),
    );
    dailyCall.on("joined-meeting", startCallTimer);
    dailyCall.on("error", (e) => setCallModalStatus("Call error: " + (e?.errorMsg || "connection lost"), true));
    // If the room ends from the OTHER side (Tavus's participant_left/absent
    // timeout, or a network drop) rather than the user clicking End, show
    // why instead of just going dark -- this was previously silent, which
    // made an early end look like a bug with no explanation.
    dailyCall.on("left-meeting", () => {
      stopCallTimer();
      setCallModalStatus("The call ended (no one joined in time, or the connection dropped). Click End and try again.", true);
    });

    // Daily's join() validates `token` as "must be a string" whenever the key
    // is present at all, even set to undefined -- omit the key entirely when
    // Tavus didn't return a meeting_token (require_auth isn't set on the
    // create-conversation call), rather than passing token: undefined.
    const joinOptions = { url: result.conversation_url };
    if (result.meeting_token) joinOptions.token = result.meeting_token;
    await dailyCall.join(joinOptions);
    setCallModalStatus("");
    attachCallPanels(currentAgent);
    listenToLiveEvents(activeConversationId);
  } catch (err) {
    setCallModalStatus("Could not start the call: " + err.message, true);
  }
});

function closeVoiceModal() {
  stopCallTimer();
  if (liveEventsAbort) { liveEventsAbort.abort(); liveEventsAbort = null; }
  if (dailyCall) {
    dailyCall.leave().catch(() => {});
    dailyCall.destroy();
    dailyCall = null;
  }
  if (activeConversationId && activeEndToken) {
    fetch("/api/tavus/end_call", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: activeConversationId, end_token: activeEndToken }),
    }).catch(() => {});
  }
  activeConversationId = null;
  activeEndToken = null;
  document.getElementById("voice-modal").close();
  restoreCallPanels();
  document.getElementById("start-call").focus();
}
document.getElementById("close-voice").addEventListener("click", closeVoiceModal);
document.getElementById("voice-modal").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeVoiceModal();
});

// --- Call control bar: Mute / Stop Video / Chat / End -----------------------

document.getElementById("call-mute").addEventListener("click", (event) => {
  if (!dailyCall) return;
  const btn = event.currentTarget;
  const nowMuted = btn.getAttribute("aria-pressed") !== "true";
  dailyCall.setLocalAudio(!nowMuted);
  btn.setAttribute("aria-pressed", String(nowMuted));
  btn.querySelector(".btn-label").textContent = nowMuted ? "Unmute" : "Mute";
  setIcon("call-mute", nowMuted ? "micOff" : "micOn");
});
document.getElementById("call-video-toggle").addEventListener("click", (event) => {
  if (!dailyCall) return;
  const btn = event.currentTarget;
  const nowOff = btn.getAttribute("aria-pressed") !== "true";
  dailyCall.setLocalVideo(!nowOff);
  btn.setAttribute("aria-pressed", String(nowOff));
  btn.querySelector(".btn-label").textContent = nowOff ? "Start Video" : "Stop Video";
  setIcon("call-video-toggle", nowOff ? "videoOff" : "videoOn");
});
document.getElementById("call-chat-toggle").addEventListener("click", (event) => {
  const btn = event.currentTarget;
  const next = btn.getAttribute("aria-pressed") !== "true";
  btn.setAttribute("aria-pressed", String(next));
  btn.querySelector(".btn-label").textContent = next ? "Chat" : "Show Chat";
  setIcon("call-chat-toggle", next ? "chatOn" : "chatOff");
  document.getElementById("transcript-wrap").classList.toggle("hidden", !next);
});

// --- Call transcript -------------------------------------------------------
//
// Transport-agnostic: these just render {role, text} lines, fed by
// deskHandleEvent() (desk.js) off the live SSE stream above.

let transcriptLog = []; // [{role, text}], accumulated for the "Save" download

function clearTranscript() {
  const wrap = document.getElementById("call-transcript");
  wrap.innerHTML = '<p class="transcript-empty">Your conversation will appear here as you talk.</p>';
  transcriptLog = [];
  document.getElementById("transcript-download").classList.add("hidden");
}

function appendTranscriptLine(role, text) {
  const wrap = document.getElementById("call-transcript");
  wrap.querySelector(".transcript-empty")?.remove();
  const speaker = role === "assistant" ? AGENT_NAMES[currentAgent] : "You";
  const div = document.createElement("div");
  div.className = "transcript-line " + role;
  const b = document.createElement("b");
  b.textContent = speaker;
  const span = document.createElement("span");
  span.textContent = text;
  div.append(b, span);
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;

  transcriptLog.push({ role: speaker, text });
  const content = transcriptLog.map((l) => `${l.role}: ${l.text}`).join("\n\n");
  const link = document.getElementById("transcript-download");
  const blob = new Blob([content], { type: "text/plain" });
  link.href = URL.createObjectURL(blob);
  link.download = `${currentAgent}-transcript.txt`;
  link.classList.remove("hidden");
}

function appendTranscriptNote(text) {
  const wrap = document.getElementById("call-transcript");
  wrap.querySelector(".transcript-empty")?.remove();
  const note = document.createElement("div");
  note.className = "transcript-note";
  note.textContent = text;
  wrap.appendChild(note);
  wrap.scrollTop = wrap.scrollHeight;
}

function appendTranscriptDownload(planEvent) {
  const wrap = document.getElementById("call-transcript");
  const name = (planEvent.boxology_file?.modelData?.boxologyId || "boxology").replace(/[^a-zA-Z0-9-]/g, "_");
  const link = document.createElement("a");
  link.className = "transcript-note";
  link.download = true;
  link.textContent = `Download ${name}.boxology`;
  setDownload(link, `${name}.boxology`, JSON.stringify(planEvent.boxology_file, null, 2));
  wrap.appendChild(link);
  wrap.scrollTop = wrap.scrollHeight;
}

// --- Boxologist: inline file generation + animated diagram preview -------------
//
// One text box, not a chat plus a separate form: Anvil's own generate_boxology
// tool (app/anvil.py) runs mid-conversation and the chat SSE stream emits a
// "plan" event carrying the finished file. This renders a download chip in
// that chat turn and, since the real Tool4Boxology editor can't be driven
// from a cross-origin iframe, draws our own cluster-by-cluster animated
// preview using the exact shapes/colors/positions plan_to_boxology() already
// computed -- then hands off to the real editor via a plain download/open link.

function setDownload(anchor, filename, content) {
  const blob = new Blob([content], { type: "application/json" });
  anchor.href = URL.createObjectURL(blob);
  anchor.download = filename;
}

function renderPlanChip(container, event) {
  const chip = document.createElement("div");
  chip.className = "boxology-result plan-chip";
  const status = document.createElement("p");
  status.textContent = event.valid
    ? "Valid — satisfies Boxology connectivity + pattern rules."
    : `Generated with issues: ${event.problems.join("; ")}`;
  const actions = document.createElement("div");
  actions.className = "actions";
  const name = (event.boxology_file?.modelData?.boxologyId || "boxology").replace(/[^a-zA-Z0-9-]/g, "_");
  const boxBtn = document.createElement("a");
  boxBtn.className = "primary-button";
  boxBtn.download = true;
  boxBtn.textContent = "Download .boxology";
  setDownload(boxBtn, `${name}.boxology`, JSON.stringify(event.boxology_file, null, 2));
  const semBtn = document.createElement("a");
  semBtn.download = true;
  semBtn.textContent = "Download semantic JSON";
  setDownload(semBtn, `${name}.json`, JSON.stringify(event.semantic_file, null, 2));
  const editorLink = document.createElement("a");
  editorLink.href = "https://tool4boxology.service.tib.eu/";
  editorLink.target = "_blank";
  editorLink.rel = "noopener noreferrer";
  editorLink.textContent = "Open in Tool4Boxology ↗";
  actions.append(boxBtn, semBtn, editorLink);
  chip.append(status, actions);
  container.appendChild(chip);
}

function resetBoxologyPreview() {
  const svg = document.getElementById("boxology-canvas");
  svg.innerHTML = "";
  document.getElementById("boxology-empty").classList.remove("hidden");
  document.getElementById("boxology-result").classList.add("hidden");
  setPanelExpanded("boxology-panel", "boxology-expand-toggle", false);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SHAPE_RADIUS = { Rectangle: 0, RoundedRectangle: 10, Triangle: 0, Hexagon: 0 };
// Real Tool4Boxology exports carry no width/height (the real editor auto-sizes
// its own shapes); our preview still needs some fixed size per root type to
// draw with, so this mirrors the real editor's own default proportions.
const SHAPE_SIZE = { Model: [150, 70], Actor: [90, 70], Transform: [120, 50],
  Train: [120, 50], Deduce: [120, 50], Engineer: [120, 50] };

function nodeSize(node) {
  const [defaultW, defaultH] = SHAPE_SIZE[node.name] || [135, 60];
  return [node.width || defaultW, node.height || defaultH];
}

const SVGNS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// GoJS node templates give every shape a soft drop shadow and route links
// orthogonally with an arrowhead, never a bare straight line -- both missing
// from the first version of this renderer, which is what made it read as a
// rough sketch instead of a proper diagram. defs are rebuilt on every render
// since the whole canvas is cleared first.
function renderSvgDefs(svg) {
  // IDs are prefixed with the target svg's own id -- this app has multiple
  // canvases alive in the DOM at once (chat preview, editor, the maximize
  // clone), and url(#id) references resolve to the FIRST matching id in the
  // whole document regardless of which svg "owns" it. Unprefixed, shared
  // literal ids meant that opening the editor (which hides the chat-view
  // subtree containing boxology-canvas's defs via display:none) made every
  // editor shape silently fail to render, since its filter/marker/pattern
  // references kept resolving to the now-hidden boxology-canvas defs instead
  // of its own.
  const prefix = svg.id;
  const defs = svgEl("defs");
  const marker = svgEl("marker", {
    id: `${prefix}-arrow`, viewBox: "0 0 10 10", refX: 8, refY: 5,
    markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse",
  });
  marker.appendChild(svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#9199b8" }));
  defs.appendChild(marker);
  const filter = svgEl("filter", { id: `${prefix}-shadow`, x: "-40%", y: "-40%", width: "180%", height: "180%" });
  filter.innerHTML = '<feDropShadow dx="0" dy="2" stdDeviation="2.2" flood-color="#1b1f3a" flood-opacity="0.22"/>';
  defs.appendChild(filter);
  const grid = svgEl("pattern", { id: `${prefix}-grid`, width: 28, height: 28, patternUnits: "userSpaceOnUse" });
  grid.appendChild(svgEl("circle", { cx: 1.2, cy: 1.2, r: 1.2, fill: "#e4e6f0" }));
  defs.appendChild(grid);
  svg.appendChild(defs);
}

// Right-angle elbow between two shape bounding boxes, exiting/entering
// whichever sides face each other -- the standard orthogonal-link look every
// real Tool4Boxology/GoJS export uses, instead of a raw diagonal line.
function orthogonalPath(from, to) {
  const dx = (to.x + to.w / 2) - (from.x + from.w / 2);
  const dy = (to.y + to.h / 2) - (from.y + from.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    const goingRight = dx >= 0;
    const startX = goingRight ? from.x + from.w : from.x, startY = from.y + from.h / 2;
    const endX = goingRight ? to.x : to.x + to.w, endY = to.y + to.h / 2;
    const midX = (startX + endX) / 2;
    return `M ${startX} ${startY} L ${midX} ${startY} L ${midX} ${endY} L ${endX} ${endY}`;
  }
  const goingDown = dy >= 0;
  const startX = from.x + from.w / 2, startY = goingDown ? from.y + from.h : from.y;
  const endX = to.x + to.w / 2, endY = goingDown ? to.y : to.y + to.h;
  const midY = (startY + endY) / 2;
  return `M ${startX} ${startY} L ${startX} ${midY} L ${endX} ${midY} L ${endX} ${endY}`;
}

function wrapLabel(text, maxCharsPerLine, maxLines) {
  const words = (text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
    if (lines.length === maxLines - 1 && current.length > maxCharsPerLine) break;
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, maxCharsPerLine - 1) + "…";
  }
  return lines;
}

// --- Export: a Boxology diagram <svg> -> PNG --------------------------------
//
// #boxology-canvas is real SVG (unlike the force-graph canvas above), so
// this rasterizes a clone of it. Node fill/stroke are already inline
// attributes (shapeElement() sets them per-node), but the group boxes,
// labels, and link strokes come from style.css classes that an SVG loaded
// standalone via a data URL can't see (no parent document, so var(--accent)
// and every #boxology-canvas .foo rule are both unavailable) -- inlined here
// with their current concrete values instead. Per-element opacity/transform
// are already inline styles from the reveal animation (see renderBoxologyPlan),
// so they survive cloneNode() untouched and don't need repeating here.
const BOXOLOGY_EXPORT_CSS =
  ".bgroup-body{fill:#f3f1e9;stroke:#d8d3c6;stroke-width:1.3px}" +
  ".bgroup-header{fill:#e8e4d6;stroke:#d8d3c6;stroke-width:1.3px}" +
  ".bgroup-label{font:600 11px Inter,sans-serif;letter-spacing:.3px;fill:#1f5132}" +
  ".bshape{stroke-width:1.6px}" +
  ".bshape-label{font:600 9px Inter,sans-serif;fill:#272b24;text-anchor:middle}" +
  ".blink{fill:none;stroke:#8f9384;stroke-width:1.6px;stroke-linecap:round;stroke-linejoin:round}";

function svgToPngBlob(svg, scale = 2) {
  return new Promise((resolve, reject) => {
    const box = svg.viewBox?.baseVal;
    const w = Math.max(1, Math.round(box?.width || svg.getBoundingClientRect().width || 800));
    const h = Math.max(1, Math.round(box?.height || svg.getBoundingClientRect().height || 500));
    const clone = svg.cloneNode(true);
    clone.setAttribute("xmlns", SVGNS);
    clone.setAttribute("width", w);
    clone.setAttribute("height", h);
    const style = document.createElementNS(SVGNS, "style");
    style.textContent = BOXOLOGY_EXPORT_CSS;
    clone.insertBefore(style, clone.firstChild);
    const bg = svgEl("rect", { x: box ? box.x : 0, y: box ? box.y : 0, width: w, height: h, fill: "#ffffff" });
    clone.insertBefore(bg, clone.firstChild);

    const xml = new XMLSerializer().serializeToString(clone);
    const svgUrl = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(svgUrl);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("canvas.toBlob returned null"))), "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(svgUrl); reject(new Error("Could not rasterize the diagram SVG")); };
    img.src = svgUrl;
  });
}

async function downloadBoxologyPng(svgId, base) {
  const svg = document.getElementById(svgId);
  if (!svg || !svg.querySelector(".bshape")) return false;
  try {
    triggerBlobDownload(`${base}.png`, await svgToPngBlob(svg));
    return true;
  } catch {
    return false;
  }
}

function shapeElement(node, svgId = "boxology-canvas") {
  const [x, y] = (node.loc || "0 0").split(" ").map(Number);
  const [w, h] = nodeSize(node);
  let el;
  if (node.shape === "Triangle") {
    el = svgEl("polygon", { points: `${x + w / 2},${y} ${x + w},${y + h} ${x},${y + h}` });
  } else if (node.shape === "Hexagon") {
    const pts = [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]
      .map(([fx, fy]) => `${x + fx * w},${y + fy * h}`).join(" ");
    el = svgEl("polygon", { points: pts });
  } else {
    el = svgEl("rect", { x, y, width: w, height: h, rx: SHAPE_RADIUS[node.shape] || 0 });
  }
  el.setAttribute("class", "bshape");
  el.setAttribute("fill", node.color || "#e5e8f0");
  el.setAttribute("stroke", node.stroke || "#9499aa");
  el.setAttribute("filter", `url(#${svgId}-shadow)`);
  const box = { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
  return { el, box };
}

function shapeLabel(node, box) {
  const text = svgEl("text", { class: "bshape-label", x: box.cx, "text-anchor": "middle" });
  const lines = wrapLabel(node.label || node.name || "", Math.max(10, Math.round(box.w / 7)), 3);
  const lineHeight = 11;
  const startY = box.cy - ((lines.length - 1) * lineHeight) / 2 + 3;
  lines.forEach((line, i) => {
    const tspan = svgEl("tspan", { x: box.cx, y: startY + i * lineHeight });
    tspan.textContent = line;
    text.appendChild(tspan);
  });
  return text;
}

async function renderBoxologyPlan(event) {
  const boxologyFile = event.boxology_file;
  setPanelExpanded("boxology-panel", "boxology-expand-toggle", true);
  const svg = document.getElementById("boxology-canvas");
  svg.innerHTML = "";
  document.getElementById("boxology-empty").classList.add("hidden");
  renderSvgDefs(svg);
  const nodes = boxologyFile?.nodeDataArray || [];
  const links = boxologyFile?.linkDataArray || [];
  const groups = nodes.filter((n) => n.isGroup);
  const shapes = nodes.filter((n) => !n.isGroup);

  // viewBox spans every shape's bounding box, with padding.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of shapes) {
    const [x, y] = (n.loc || "0 0").split(" ").map(Number);
    const [w, h] = nodeSize(n);
    minX = Math.min(minX, x - 40); minY = Math.min(minY, y - 30);
    maxX = Math.max(maxX, x + w + 40); maxY = Math.max(maxY, y + h + 30);
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 400; maxY = 300; }
  svg.setAttribute("viewBox", `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
  svg.appendChild(svgEl("rect", { x: minX, y: minY, width: maxX - minX, height: maxY - minY, fill: `url(#${svg.id}-grid)` }));

  const layer = svgEl("g");
  svg.appendChild(layer);
  const linkLayer = svgEl("g");
  layer.appendChild(linkLayer);

  const revealed = new Map(); // key -> {x,y,w,h,cx,cy}

  async function revealGroup(group) {
    // Bounding box (and this pass's reveal set) from DIRECT members only --
    // a shared node has exactly one drawn position (wherever it ended up in
    // boxology_layout.py's output), so counting it toward every cluster it's
    // merely associated with stretches that cluster's box to engulf whatever
    // cluster actually holds it. Shared nodes still get drawn -- by the
    // catch-all pass below, same as any other not-yet-revealed node.
    const members = shapes.filter((n) => n.group === group.key);
    if (!members.length) return;
    let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;
    for (const n of members) {
      const [x, y] = (n.loc || "0 0").split(" ").map(Number);
      const [w, h] = nodeSize(n);
      gMinX = Math.min(gMinX, x); gMinY = Math.min(gMinY, y);
      gMaxX = Math.max(gMaxX, x + w); gMaxY = Math.max(gMaxY, y + h);
    }
    const pad = 24, headerH = 24;
    const boxX = gMinX - pad, boxY = gMinY - pad - headerH;
    const boxW = gMaxX - gMinX + pad * 2, boxH = gMaxY - gMinY + pad * 2 + headerH;
    const groupEl = svgEl("g", { class: "bgroup" });
    const body = svgEl("rect", { x: boxX, y: boxY, width: boxW, height: boxH, rx: 10, class: "bgroup-body" });
    const header = svgEl("path", {
      class: "bgroup-header",
      d: `M ${boxX} ${boxY + 10} Q ${boxX} ${boxY} ${boxX + 10} ${boxY} L ${boxX + boxW - 10} ${boxY} `
        + `Q ${boxX + boxW} ${boxY} ${boxX + boxW} ${boxY + 10} L ${boxX + boxW} ${boxY + headerH} L ${boxX} ${boxY + headerH} Z`,
    });
    const label = svgEl("text", { class: "bgroup-label", x: boxX + 10, y: boxY + headerH - 8 });
    label.textContent = group.label || "";
    groupEl.append(body, header, label);
    layer.insertBefore(groupEl, linkLayer.nextSibling);
    groupEl.style.transition = "opacity .35s";
    await sleep(20);
    groupEl.style.opacity = "1";
    await sleep(220);

    for (const node of members) {
      if (revealed.has(node.key)) continue;
      const { el, box } = shapeElement(node, svg.id);
      const text = shapeLabel(node, box);
      layer.appendChild(el);
      layer.appendChild(text);
      revealed.set(node.key, box);
      el.style.transition = "opacity .3s, transform .3s";
      text.style.transition = "opacity .3s";
      el.style.transformBox = "fill-box"; el.style.transformOrigin = "center";
      el.style.transform = "scale(0.6)";
      await sleep(20);
      el.style.opacity = "1"; el.style.transform = "scale(1)"; text.style.opacity = "1";
      await sleep(260);
    }
  }

  for (const group of groups) {
    await revealGroup(group);
  }
  // Shared nodes spanning multiple clusters, and any ungrouped strays, last.
  for (const node of shapes) {
    if (revealed.has(node.key)) continue;
    const { el, box } = shapeElement(node, svg.id);
    const text = shapeLabel(node, box);
    layer.appendChild(el); layer.appendChild(text);
    revealed.set(node.key, box);
    el.style.transition = "opacity .3s, transform .3s"; text.style.transition = "opacity .3s";
    el.style.transformBox = "fill-box"; el.style.transformOrigin = "center";
    el.style.transform = "scale(0.6)";
    await sleep(20);
    el.style.opacity = "1"; el.style.transform = "scale(1)"; text.style.opacity = "1";
    await sleep(180);
  }

  // Re-append linkLayer last: it was created first (so appendGroup's
  // insertBefore logic had a stable anchor), which otherwise paints every
  // link underneath the group boxes' fill -- invisible wherever a link
  // passes through a cluster's background, not just a z-index nitpick.
  layer.appendChild(linkLayer);
  for (const link of links) {
    const from = revealed.get(link.from), to = revealed.get(link.to);
    if (!from || !to) continue;
    const path = svgEl("path", { class: "blink", d: orthogonalPath(from, to), "marker-end": `url(#${svg.id}-arrow)` });
    linkLayer.appendChild(path);
    const len = path.getTotalLength();
    path.style.strokeDasharray = String(len);
    path.style.strokeDashoffset = String(len);
    path.style.transition = "stroke-dashoffset .4s ease, opacity .15s";
    await sleep(15);
    path.style.opacity = "1";
    path.style.strokeDashoffset = "0";
    await sleep(140);
  }

  const name = (boxologyFile?.modelData?.boxologyId || "boxology").replace(/[^a-zA-Z0-9-]/g, "_");
  document.getElementById("boxology-result-status").textContent = event.valid
    ? "Valid — satisfies Boxology connectivity + pattern rules."
    : `Generated with issues: ${(event.problems || []).join("; ")}`;
  setDownload(document.getElementById("boxology-download"), `${name}.boxology`, JSON.stringify(boxologyFile, null, 2));
  setDownload(document.getElementById("boxology-download-semantic"), `${name}.json`, JSON.stringify(event.semantic_file, null, 2));
  document.getElementById("boxology-download-png").onclick = (event) => {
    event.preventDefault();
    downloadBoxologyPng("boxology-canvas", name);
  };
  document.getElementById("boxology-result").classList.remove("hidden");
}

document.getElementById("graph-expand-toggle").addEventListener("click", () => togglePanelExpand("graph-panel", "graph-expand-toggle"));
document.getElementById("boxology-expand-toggle").addEventListener("click", () => togglePanelExpand("boxology-panel", "boxology-expand-toggle"));

// --- Cartographer graph: maximize view --------------------------------------
//
// Unlike the Boxology diagram's maximize (below, a <dialog> that clones the
// static SVG into its own canvas), the force-graph instance is a live
// simulation tied to one specific canvas element -- cloning it would mean
// running a second, separately-ticking copy in parallel. Simpler and
// correct: fixed-position the exact same #graph-panel edge-to-edge over the
// viewport (CSS .maximized, style.css) and let the canvas-wrap's existing
// ResizeObserver (ensureForceGraph()) pick up the new size on its own, the
// same way it already reacts to the panel-resizer drag or the .expanded
// width toggle.
function openGraphMaximize() {
  document.getElementById("graph-panel").classList.add("maximized");
  document.getElementById("graph-maximize-close").classList.remove("hidden");
  document.getElementById("graph-maximize-toggle").setAttribute("aria-pressed", "true");
  document.body.style.overflow = "hidden"; // nothing left to scroll behind a full-viewport panel
  document.addEventListener("keydown", graphMaximizeEscapeHandler);
  // Re-fit once the resize has actually taken effect, rather than racing it.
  requestAnimationFrame(() => requestAnimationFrame(() => { if (fg) fg.zoomToFit(300, 60); }));
}
function closeGraphMaximize() {
  document.getElementById("graph-panel").classList.remove("maximized");
  document.getElementById("graph-maximize-close").classList.add("hidden");
  document.getElementById("graph-maximize-toggle").setAttribute("aria-pressed", "false");
  document.body.style.overflow = "";
  document.removeEventListener("keydown", graphMaximizeEscapeHandler);
  requestAnimationFrame(() => requestAnimationFrame(() => { if (fg) fg.zoomToFit(300, 60); }));
}
function graphMaximizeEscapeHandler(event) { if (event.key === "Escape") closeGraphMaximize(); }
document.getElementById("graph-maximize-toggle").addEventListener("click", () => {
  document.getElementById("graph-panel").classList.contains("maximized") ? closeGraphMaximize() : openGraphMaximize();
});
document.getElementById("graph-maximize-close").addEventListener("click", closeGraphMaximize);

// --- Boxologist diagram: maximize view --------------------------------------
//
// The expand-toggle above only widens the side panel (up to 60vw); this opens
// a true near-fullscreen dialog for actually reading a dense diagram. Clones
// the already-rendered #boxology-canvas markup rather than re-rendering --
// it's static SVG once drawn, so a markup copy is enough.

// viewBox-based zoom/pan state for the maximize dialog. maxBaseView is the
// fitted "show everything" frame (Fit button / reset target); maxView is the
// live frame mutated by zoom + pan.
let maxView = null;
let maxBaseView = null;

function openBoxologyMaximize() {
  const source = document.getElementById("boxology-canvas");
  const target = document.getElementById("boxology-maximize-canvas");
  // Rewrite the cloned defs' id prefix so it doesn't collide with the (still
  // rendered, not hidden) source canvas's own "boxology-canvas-*" ids --
  // duplicate ids would make url(#...) resolution ambiguous, picking
  // whichever element happens to come first in the document.
  target.innerHTML = source.innerHTML.split("boxology-canvas-").join("boxology-maximize-canvas-");
  target.setAttribute("preserveAspectRatio", "xMidYMid meet");
  target.style.cursor = "grab";

  const sourceDownload = document.getElementById("boxology-download");
  const maxDownload = document.getElementById("boxology-maximize-download");
  if (sourceDownload.href) {
    maxDownload.href = sourceDownload.href;
    maxDownload.download = sourceDownload.download;
    maxDownload.classList.remove("hidden");
  } else {
    maxDownload.classList.add("hidden");
  }

  document.getElementById("boxology-maximize-modal").showModal();
  // getBBox needs the SVG laid out -- it is, once the dialog is shown. rAF is a
  // belt-and-suspenders refit in case the first measure races layout.
  fitMaximizeView();
  requestAnimationFrame(fitMaximizeView);
}

function fitMaximizeView() {
  const svg = document.getElementById("boxology-maximize-canvas");
  const layer = svg.querySelector("g");
  let bb = null;
  try { bb = layer && layer.getBBox(); } catch (_) { bb = null; }
  if (!bb || !bb.width) {
    const vb = (svg.getAttribute("viewBox") || "0 0 400 300").split(" ").map(Number);
    bb = { x: vb[0], y: vb[1], width: vb[2], height: vb[3] };
  }
  // Tight fit to actual content with a small margin, so a wide-short diagram
  // fills the frame instead of floating small in the middle.
  const pad = Math.max(bb.width, bb.height) * 0.03 + 16;
  maxBaseView = { x: bb.x - pad, y: bb.y - pad, w: bb.width + pad * 2, h: bb.height + pad * 2 };
  maxView = { ...maxBaseView };
  applyMaxView();
}

function applyMaxView() {
  if (!maxView) return;
  document.getElementById("boxology-maximize-canvas")
    .setAttribute("viewBox", `${maxView.x} ${maxView.y} ${maxView.w} ${maxView.h}`);
}

// Zoom around a point in viewBox coords, keeping that point visually fixed.
function zoomMaxAround(px, py, factor) {
  if (!maxView || !maxBaseView) return;
  const w = maxView.w / factor;
  const minW = maxBaseView.w / 12, maxW = maxBaseView.w * 2.5;
  if (w < minW || w > maxW) return;
  maxView.x = px - (px - maxView.x) / factor;
  maxView.y = py - (py - maxView.y) / factor;
  maxView.w = w;
  maxView.h = maxView.h / factor;
  applyMaxView();
}

function zoomMaxButton(factor) {
  if (!maxView) return;
  zoomMaxAround(maxView.x + maxView.w / 2, maxView.y + maxView.h / 2, factor);
}

function initMaximizePanZoom() {
  const svg = document.getElementById("boxology-maximize-canvas");
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  svg.addEventListener("pointerdown", (e) => {
    if (!maxView) return;
    dragging = true;
    svg.setPointerCapture(e.pointerId);
    svg.style.cursor = "grabbing";
    sx = e.clientX; sy = e.clientY; ox = maxView.x; oy = maxView.y;
  });
  svg.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const r = svg.getBoundingClientRect();
    maxView.x = ox - (e.clientX - sx) * (maxView.w / r.width);
    maxView.y = oy - (e.clientY - sy) * (maxView.h / r.height);
    applyMaxView();
  });
  const stop = () => { dragging = false; svg.style.cursor = "grab"; };
  svg.addEventListener("pointerup", stop);
  svg.addEventListener("pointercancel", stop);
  svg.addEventListener("wheel", (e) => {
    if (!maxView) return;
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const px = maxView.x + (e.clientX - r.left) * (maxView.w / r.width);
    const py = maxView.y + (e.clientY - r.top) * (maxView.h / r.height);
    zoomMaxAround(px, py, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });
}

document.getElementById("boxology-maximize-toggle").addEventListener("click", openBoxologyMaximize);
document.getElementById("boxology-maximize-close").addEventListener("click", () => {
  document.getElementById("boxology-maximize-modal").close();
});
document.getElementById("boxology-maximize-modal").addEventListener("cancel", (event) => {
  event.preventDefault();
  document.getElementById("boxology-maximize-modal").close();
});
document.getElementById("boxology-zoom-in").addEventListener("click", () => zoomMaxButton(1.25));
document.getElementById("boxology-zoom-out").addEventListener("click", () => zoomMaxButton(1 / 1.25));
document.getElementById("boxology-zoom-reset").addEventListener("click", fitMaximizeView);
initMaximizePanZoom();

function togglePanelExpand(panelId, btnId) {
  const expanded = !document.getElementById(panelId).classList.contains("expanded");
  setPanelExpanded(panelId, btnId, expanded);
}

function setPanelExpanded(panelId, btnId, expanded) {
  document.getElementById(panelId).classList.toggle("expanded", expanded);
  document.getElementById(btnId).setAttribute("aria-pressed", String(expanded));
}

resetCallControls();
updateCallButton();

// ===========================================================================
// Redesign additions: Markdown, dashboard/projects/templates, local project
// store, mobile tabs, panel resizer. All presentation -- no API changes.
// ===========================================================================

// --- Minimal, safe Markdown -> HTML (no exposed ** markers, no raw HTML) ----
function mdEscape(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function mdInline(s) {
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}
function renderMarkdown(src) {
  if (!src) return "";
  let text = mdEscape(src);
  const blocks = [];
  text = text.replace(/```([\s\S]*?)```/g, (_m, code) => {
    blocks.push(code.replace(/^\n/, "").replace(/\n$/, ""));
    return ` CODE${blocks.length - 1} `;
  });
  const lines = text.split(/\r?\n/);
  let html = "", listType = null, para = [];
  const flushPara = () => { if (para.length) { html += "<p>" + mdInline(para.join(" ")) + "</p>"; para = []; } };
  const flushList = () => { if (listType) { html += `</${listType}>`; listType = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const codeMatch = line.trim().match(/^ CODE(\d+) $/);
    if (codeMatch) { flushPara(); flushList(); html += `<pre><code>${blocks[+codeMatch[1]]}</code></pre>`; continue; }
    if (line.trim() === "") { flushPara(); flushList(); continue; }
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { flushPara(); flushList(); const lvl = m[1].length; html += `<h${lvl}>${mdInline(m[2])}</h${lvl}>`; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flushPara(); flushList(); html += "<hr>"; continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); flushList(); html += `<blockquote>${mdInline(m[1])}</blockquote>`; continue; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { flushPara(); if (listType !== "ul") { flushList(); html += "<ul>"; listType = "ul"; } html += `<li>${mdInline(m[1])}</li>`; continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); if (listType !== "ol") { flushList(); html += "<ol>"; listType = "ol"; } html += `<li>${mdInline(m[1])}</li>`; continue; }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return html;
}

// Turns literal "[n]" citation markers left in the rendered answer text into
// clickable buttons (only for n's we actually have source data for -- a bare
// "[1]" the model didn't mean as a citation is left as plain text). Also
// handles "[5, 6]"-style combined brackets -- despite the system prompt
// asking for one source per bracket, the model doesn't always split them --
// by making each number inside independently clickable while leaving the
// brackets/commas as plain text. Walks text nodes rather than regexing the
// HTML string so it can't corrupt tags, and skips text inside code/pre so a
// literal "[1]" in a code sample is left alone.
function linkifyCitations(root, citations) {
  if (!citations || !Object.keys(citations).length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest("pre, code")
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);

  const citeRe = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
  for (const textNode of textNodes) {
    const text = textNode.nodeValue;
    citeRe.lastIndex = 0;
    if (!citeRe.test(text)) continue;
    citeRe.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = citeRe.exec(text))) {
      const nums = m[1].split(/\s*,\s*/).map(Number);
      if (!nums.some((n) => citations[n])) continue;
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      frag.appendChild(document.createTextNode("["));
      nums.forEach((num, i) => {
        if (i > 0) frag.appendChild(document.createTextNode(", "));
        if (citations[num]) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "cite-ref";
          btn.dataset.citation = String(num);
          btn.textContent = String(num);
          frag.appendChild(btn);
        } else {
          frag.appendChild(document.createTextNode(String(num)));
        }
      });
      frag.appendChild(document.createTextNode("]"));
      last = citeRe.lastIndex;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    textNode.parentNode.replaceChild(frag, textNode);
  }
}

// --- Toast ------------------------------------------------------------------
let toastTimer = null;
function toast(message) {
  let el = document.getElementById("app-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "app-toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// --- My projects: per-user server dashboard when signed in, browser-local --
//
// Signed-in sessions (currentUser set, applyProfile()) save/list/delete
// through /api/projects (app/projects_store.py -- a Modal Dict, so a project
// saved on one device shows up on any other). No session means no username
// to key a server-side save by, so that case (AUTH_ENABLED off, the default
// local/dev config) keeps the original browser-only localStorage behavior,
// unchanged. A server call that fails (offline, etc.) falls back to saving
// locally too, rather than losing the save entirely.

const PROJECTS_KEY = "boxology.projects.v1";
function loadLocalProjects() { try { return JSON.parse(localStorage.getItem(PROJECTS_KEY)) || []; } catch { return []; } }
function persistLocalProjects(list) { try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(list)); } catch { } }

async function loadProjects() {
  if (currentUser) {
    try {
      const res = await fetch("/api/projects");
      if (res.ok) return (await res.json()).projects || [];
    } catch { /* fall through to the local list below */ }
  }
  return loadLocalProjects();
}

async function persistProject(record) {
  if (currentUser) {
    try {
      const res = await fetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      });
      if (res.ok) return (await res.json()).project;
    } catch { /* fall through to saving locally instead */ }
  }
  const list = loadLocalProjects();
  const id = record.id || ("p" + Date.now());
  const now = new Date().toISOString();
  const existing = list.find((p) => p.id === id);
  const stored = { ...record, id, updatedAt: now, createdAt: (existing && existing.createdAt) || now };
  const idx = list.findIndex((p) => p.id === id);
  if (idx >= 0) list[idx] = stored; else list.unshift(stored);
  persistLocalProjects(list);
  return stored;
}

async function removeProject(id) {
  if (currentUser) {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.ok) return;
    } catch { /* fall through to local removal below */ }
  }
  persistLocalProjects(loadLocalProjects().filter((p) => p.id !== id));
}

function timeAgo(isoOrMs) {
  const t = typeof isoOrMs === "number" ? isoOrMs : new Date(isoOrMs).getTime();
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Snapshots whatever extra artifacts the CURRENTLY ACTIVE agent has produced
// this session -- the generated diagram (+ its semantic JSON) for
// Boxologist, the graph PNG + the SPARQL query text for Cartographer.
// Scholar has nothing beyond its own text+sources, already part of the saved
// transcript, so there's no case for it.
async function collectProjectArtifacts() {
  const artifacts = {};
  if (currentAgent === "anvil" && editorDiagram) {
    artifacts.boxologyFile = editorDiagram;
    if (lastSemanticFile) artifacts.semanticFile = lastSemanticFile;
    try {
      const svg = document.getElementById("boxology-canvas");
      if (svg && svg.querySelector(".bshape")) artifacts.diagramPng = await blobToDataUrl(await svgToPngBlob(svg));
    } catch { /* PNG snapshot is best-effort -- the JSON artifacts above still save */ }
  }
  if (currentAgent === "cartographer" && graphNodes.length) {
    artifacts.sparqlQuery = lastSparqlQuery || "";
    try {
      const blob = await graphCanvasToPngBlob();
      if (blob) artifacts.graphPng = await blobToDataUrl(blob);
    } catch { /* best-effort, same as above */ }
  }
  return artifacts;
}

// Re-running the saved SPARQL query (Cartographer) gives back a fresh, fully
// interactive graph matching what was saved -- truer to this tool's "live,
// explainable" point than replaying a flattened PNG. Boxologist's own
// diagram replays directly from its stored JSON (an exact, static document,
// not a query result), via the same renderer a live plan event uses.
async function restoreProjectArtifacts(p) {
  const a = p.artifacts || {};
  if (p.agent === "anvil" && a.boxologyFile) {
    editorDiagram = a.boxologyFile;
    lastSemanticFile = a.semanticFile || null;
    renderBoxologyPlan({ boxology_file: a.boxologyFile, semantic_file: a.semanticFile, valid: true, problems: [] });
  }
  if (p.agent === "cartographer" && a.sparqlQuery) {
    lastSparqlQuery = a.sparqlQuery;
    try {
      const res = await fetch("/api/sparql", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: a.sparqlQuery }),
      });
      const data = await res.json();
      if (!data.error) await ingestSparqlResult(data.vars, data.rows);
    } catch { /* best-effort -- the project itself still opened fine */ }
  }
}

async function saveCurrentProject() {
  agentSessions[currentAgent] = { history, nodes: Array.from(messagesEl.childNodes) };
  const histories = {};
  for (const a of Object.keys(AGENT_NAMES)) {
    const s = agentSessions[a];
    if (s && s.history && s.history.length) histories[a] = s.history;
  }
  if (!Object.keys(histories).length) { toast("Start a conversation first, then save."); return; }
  let title = document.getElementById("project-title").textContent.trim();
  if (!title || title === "Untitled session") {
    const firstUser = (histories[currentAgent] || Object.values(histories)[0]).find((m) => m.role === "user");
    title = firstUser ? firstUser.content.slice(0, 64) : AGENT_NAMES[currentAgent] + " session";
  }
  const saveBtn = document.getElementById("save-project");
  saveBtn.disabled = true;
  try {
    const artifacts = await collectProjectArtifacts();
    const record = { title, agent: currentAgent, histories, artifacts };
    if (currentProjectId) record.id = currentProjectId;
    const saved = await persistProject(record);
    currentProjectId = saved.id;
    document.getElementById("project-title").textContent = title;
    toast(currentUser ? "Project saved to your dashboard" : "Project saved in this browser");
  } finally {
    saveBtn.disabled = false;
  }
}

function buildMessageNodes(histArr) {
  return histArr.map((m) => {
    const div = document.createElement("div");
    div.className = "msg " + (m.role === "user" ? "user" : "assistant");
    div.innerHTML = '<div class="msg-text"></div>';
    const t = div.querySelector(".msg-text");
    if (m.role === "user") t.textContent = m.content; else t.innerHTML = renderMarkdown(m.content);
    return div;
  });
}

async function openProject(id) {
  const projects = await loadProjects();
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  currentProjectId = p.id;
  Object.keys(agentSessions).forEach((k) => delete agentSessions[k]);
  for (const [a, h] of Object.entries(p.histories || {})) {
    agentSessions[a] = { history: h.slice(), nodes: buildMessageNodes(h) };
  }
  switchAgent(p.agent || "scholar", true, true);
  document.getElementById("project-title").textContent = p.title;
  navigate("assistants");
  restoreProjectArtifacts(p);
}

async function deleteProject(id) {
  await removeProject(id);
  if (currentProjectId === id) { currentProjectId = null; document.getElementById("project-title").textContent = "Untitled session"; }
  renderProjects();
}
document.getElementById("save-project").addEventListener("click", saveCurrentProject);

function projectRow(p) {
  const row = document.createElement("div");
  row.className = "project-row";
  const thumbSrc = p.artifacts?.diagramPng || p.artifacts?.graphPng;
  if (thumbSrc) {
    const thumb = document.createElement("img");
    thumb.className = "project-row-thumb";
    thumb.src = thumbSrc;
    thumb.alt = "";
    row.appendChild(thumb);
  } else {
    const avatar = document.createElement("span");
    avatar.className = "avatar " + p.agent;
    row.appendChild(avatar);
  }
  const main = document.createElement("div");
  main.className = "project-row-main";
  const title = document.createElement("strong");
  title.textContent = p.title;
  const meta = document.createElement("div");
  meta.className = "project-row-meta";
  meta.textContent = `${AGENT_NAMES[p.agent] || "Assistant"} · updated ${timeAgo(p.updatedAt ?? p.updated)}`;
  main.append(title, meta);
  const actions = document.createElement("div");
  actions.className = "project-row-actions";
  if (thumbSrc) {
    const dl = document.createElement("a");
    dl.className = "secondary-button";
    dl.textContent = "Image ↓";
    dl.href = thumbSrc;
    dl.download = `${(p.title || "project").replace(/[^a-zA-Z0-9-]/g, "_")}.png`;
    actions.appendChild(dl);
  }
  const cont = document.createElement("button");
  cont.className = "secondary-button";
  cont.textContent = "Continue";
  cont.addEventListener("click", () => openProject(p.id));
  const del = document.createElement("button");
  del.className = "project-delete";
  del.setAttribute("aria-label", "Delete project");
  del.textContent = "×";
  del.addEventListener("click", () => deleteProject(p.id));
  actions.append(cont, del);
  row.append(main, actions);
  return row;
}

async function renderProjects() {
  const list = document.getElementById("projects-list");
  const q = (document.getElementById("project-search").value || "").toLowerCase();
  const allProjects = await loadProjects();
  const projects = allProjects.filter((p) =>
    !q || p.title.toLowerCase().includes(q) || (AGENT_NAMES[p.agent] || "").toLowerCase().includes(q));
  list.innerHTML = "";
  if (!projects.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = allProjects.length
      ? "<strong>No matches</strong>Try a different search term."
      : "<strong>No saved projects yet</strong>Start a conversation with an assistant, then use <b>Save project</b> to keep it here.";
    list.appendChild(empty);
    return;
  }
  projects.forEach((p) => list.appendChild(projectRow(p)));
}
document.getElementById("project-search").addEventListener("input", renderProjects);

// --- Templates (editable starting prompts) ----------------------------------
const TEMPLATES = [
  { agent: "anvil", title: "Warehouse box detection + storage rules",
    prompt: "We have images from a warehouse where workers first label boxes and shelves. Then we train a model to recognize where every box is. After that, a robot uses the detected boxes together with warehouse storage rules to decide where to put new items." },
  { agent: "anvil", title: "Clinical decision support pipeline",
    prompt: "Design a neuro-symbolic clinical decision support system: a neural model reads patient data and imaging, a symbolic reasoner applies clinical guidelines, and the two combine to recommend a diagnosis with an explanation." },
  { agent: "scholar", title: "Literature survey starter",
    prompt: "Summarize the main approaches to combining neural networks with symbolic reasoning for medical diagnosis, and list the key papers with their contributions." },
  { agent: "cartographer", title: "Explore rules for a component",
    prompt: "Find positive rules involving Model, then show the boxologies that use them." },
];
function renderTemplates() {
  const list = document.getElementById("templates-list");
  if (list.dataset.built) return; // static content -- build once
  list.dataset.built = "1";
  for (const t of TEMPLATES) {
    const card = document.createElement("article");
    card.className = "template-card";
    const head = document.createElement("div");
    head.className = "template-card-head";
    const chip = document.createElement("span");
    chip.className = "template-chip " + t.agent;
    chip.textContent = AGENT_NAMES[t.agent];
    const h3 = document.createElement("h3");
    h3.textContent = t.title;
    head.append(chip, h3);
    const ta = document.createElement("textarea");
    ta.value = t.prompt;
    ta.setAttribute("aria-label", t.title + " prompt");
    const foot = document.createElement("div");
    foot.className = "template-card-foot";
    const use = document.createElement("button");
    use.className = "primary-button";
    use.textContent = `Use with ${AGENT_NAMES[t.agent]} →`;
    use.addEventListener("click", () => {
      switchAgent(t.agent, true);
      input.value = ta.value;
      navigate("assistants");
      input.focus();
    });
    foot.appendChild(use);
    card.append(head, ta, foot);
    list.appendChild(card);
  }
}

// --- Overview dashboard -----------------------------------------------------
function assistantTile(agent) {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "assistant-tile";
  tile.innerHTML = `<span class="avatar ${agent}" aria-hidden="true"></span>`
    + `<h3>${AGENT_NAMES[agent]}</h3><p>${AGENT_PURPOSE[agent]}</p>`
    + `<span class="tile-action">${AGENT_ACTION[agent]} →</span>`;
  tile.addEventListener("click", () => { switchAgent(agent, true); navigate("assistants"); });
  return tile;
}
async function renderOverview() {
  const grid = document.getElementById("overview-assistants");
  if (!grid.dataset.built) {
    grid.dataset.built = "1";
    ["scholar", "anvil", "cartographer"].forEach((a) => grid.appendChild(assistantTile(a)));
  }
  const recent = document.getElementById("overview-projects");
  recent.innerHTML = "";
  const projects = (await loadProjects()).slice(0, 4);
  if (!projects.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = "<strong>No projects yet</strong>Start a session and save it to see it here.";
    recent.appendChild(empty);
  } else {
    const wrap = document.createElement("div");
    wrap.className = "projects-list";
    projects.forEach((p) => wrap.appendChild(projectRow(p)));
    recent.appendChild(wrap);
  }
}

// --- Getting started: assistant list ----------------------------------------
function renderGuide() {
  const ul = document.getElementById("guide-assistants");
  if (ul.dataset.built) return;
  ul.dataset.built = "1";
  for (const a of ["scholar", "anvil", "cartographer"]) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="avatar ${a}" aria-hidden="true"></span>`
      + `<div><strong>${AGENT_NAMES[a]}</strong><p>${AGENT_PURPOSE[a]}</p></div>`;
    ul.appendChild(li);
  }
}
document.getElementById("try-example-prompt").addEventListener("click", () => {
  switchAgent("anvil", true);
  input.value = document.querySelector("#view-getting-started .example-prompt p").textContent.replace(/[“”]/g, "").trim();
  navigate("assistants");
  input.focus();
});

// --- Mobile Chat/Output tabs ------------------------------------------------
function showMobilePane(which) {
  const chat = document.getElementById("chat-main-pane");
  const out = currentAgent === "anvil" ? document.getElementById("boxology-panel")
    : currentAgent === "cartographer" ? document.getElementById("graph-panel") : null;
  const chatTab = document.getElementById("mtab-chat");
  const outTab = document.getElementById("mtab-output");
  chatTab.classList.toggle("active", which === "chat");
  outTab.classList.toggle("active", which === "output");
  chatTab.setAttribute("aria-selected", String(which === "chat"));
  outTab.setAttribute("aria-selected", String(which === "output"));
  chat.classList.toggle("mobile-hidden", which === "output");
  if (out) out.classList.toggle("mobile-hidden", which === "chat");
}
document.getElementById("mtab-chat").addEventListener("click", () => showMobilePane("chat"));
document.getElementById("mtab-output").addEventListener("click", () => showMobilePane("output"));

// --- Desktop panel resizer --------------------------------------------------
(function () {
  const resizer = document.getElementById("panel-resizer");
  let dragging = false;
  const outPanel = () => currentAgent === "anvil" ? document.getElementById("boxology-panel")
    : currentAgent === "cartographer" ? document.getElementById("graph-panel") : null;
  resizer.addEventListener("pointerdown", (e) => {
    if (!outPanel()) return;
    dragging = true; resizer.setPointerCapture(e.pointerId); e.preventDefault();
  });
  resizer.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const p = outPanel(); if (!p) return;
    const wrap = document.getElementById("chat-with-graph");
    const rect = wrap.getBoundingClientRect();
    let w = rect.right - e.clientX;
    w = Math.max(280, Math.min(rect.width - 340, w));
    p.style.width = w + "px";
  });
  const stop = () => { dragging = false; };
  resizer.addEventListener("pointerup", stop);
  resizer.addEventListener("pointercancel", stop);
  resizer.addEventListener("keydown", (e) => {
    const p = outPanel(); if (!p) return;
    const cur = p.getBoundingClientRect().width;
    if (e.key === "ArrowLeft") { p.style.width = (cur + 30) + "px"; e.preventDefault(); }
    if (e.key === "ArrowRight") { p.style.width = Math.max(280, cur - 30) + "px"; e.preventDefault(); }
  });
})();

// --- Login screen + per-user profile -----------------------------------------
//
// Gates app init (below) behind GET /api/auth/me: {auth_enabled:false} skips
// the login screen entirely (nothing to sign into); {auth_enabled:true,
// user:null} shows it; a user already means a still-valid session cookie
// from an earlier visit, so it's skipped too. One cookie, no separate CSRF
// token -- samesite=strict already stops a cross-site page from riding it.

let selectedLoginUsername = null;
// Set once a real session is confirmed (applyProfile()) -- "My projects"
// (below) uses this to decide whether to save/list/delete through the
// server-side per-user store (/api/projects, cross-device) or fall back to
// the old browser-local store (no session to key a server-side save by).
let currentUser = null;

function applyProfile(user) {
  const img = document.getElementById("profile-avatar");
  const fallback = document.getElementById("profile-avatar-fallback");
  if (user) {
    currentUser = user;
    img.src = user.avatar;
    img.hidden = false;
    fallback.hidden = true;
    document.getElementById("profile-name").textContent = user.name;
    document.getElementById("profile-role").textContent = user.role;
    document.getElementById("profile-logout").classList.remove("hidden");
  }
}

// Treat the welcome screen as the active page, including for keyboard and
// assistive technology users; the workspace remains mounted for app startup.
function setLoginVisibility(visible) {
  const screen = document.getElementById("login-screen");
  screen.hidden = !visible;
  document.body.classList.toggle("login-active", visible);
  document.querySelectorAll("body > .mobile-topbar, body > .sidebar-scrim, body > .sidebar, body > .workspace").forEach((el) => { el.inert = visible; });
  document.querySelector(".skip-link").href = visible ? "#welcome" : "#main-content";
}

function showLoginScreen() {
  setLoginVisibility(true);
}

function hideLoginScreen() {
  setLoginVisibility(false);
}

function initLoginScreen() {
  const profiles = document.querySelectorAll(".login-profile");
  const form = document.getElementById("login-form");
  const passwordInput = document.getElementById("login-password");
  const errorEl = document.getElementById("login-error");

  profiles.forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedLoginUsername = btn.dataset.username;
      profiles.forEach((b) => {
        b.classList.toggle("selected", b === btn);
        b.setAttribute("aria-pressed", String(b === btn));
      });
      document.getElementById("login-username").value = selectedLoginUsername;
      document.getElementById("login-selected-name").textContent = `for ${btn.querySelector("strong").textContent}`;
      passwordInput.removeAttribute("aria-invalid");
      passwordInput.type = "password";
      const toggle = document.getElementById("login-toggle-password");
      toggle.textContent = "Show";
      toggle.setAttribute("aria-label", "Show password");
      toggle.setAttribute("aria-pressed", "false");
      form.classList.remove("hidden");
      errorEl.classList.add("hidden");
      passwordInput.value = "";
      passwordInput.focus();
    });
  });

  document.getElementById("login-toggle-password").addEventListener("click", (event) => {
    const show = passwordInput.type === "password";
    passwordInput.type = show ? "text" : "password";
    event.currentTarget.textContent = show ? "Hide" : "Show";
    event.currentTarget.setAttribute("aria-label", show ? "Hide password" : "Show password");
    event.currentTarget.setAttribute("aria-pressed", String(show));
  });

  passwordInput.addEventListener("input", () => {
    passwordInput.removeAttribute("aria-invalid");
    errorEl.classList.add("hidden");
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!selectedLoginUsername) return;
    const submitBtn = document.getElementById("login-submit");
    if (submitBtn.disabled) return;
    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in...";
    form.setAttribute("aria-busy", "true");
    profiles.forEach((btn) => { btn.disabled = true; });
    errorEl.classList.add("hidden");
    passwordInput.removeAttribute("aria-invalid");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: selectedLoginUsername, password: passwordInput.value }),
      });
      const data = await res.json();
      if (!res.ok) {
        errorEl.textContent = data.error || "Could not sign in. Check your password and try again.";
        errorEl.classList.remove("hidden");
        passwordInput.setAttribute("aria-invalid", "true");
        passwordInput.focus();
        return;
      }
      applyProfile(data.user);
      passwordInput.value = "";
      hideLoginScreen();
      startApp();
      document.getElementById("main-content").setAttribute("tabindex", "-1");
      document.getElementById("main-content").focus();
    } catch {
      errorEl.textContent = "Could not reach the server. Please try again.";
      errorEl.classList.remove("hidden");
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = 'Sign in to workspace <span aria-hidden="true">&rarr;</span>';
      form.removeAttribute("aria-busy");
      profiles.forEach((btn) => { btn.disabled = false; });
    }
  });

  document.getElementById("profile-logout").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.reload();
  });
}

// --- Init: normalize the default agent state, land on the dashboard ---------
function startApp() {
  switchAgent("scholar", true);
  navigate("overview");
}

initLoginScreen();
fetch("/api/auth/me")
  .then((res) => res.json())
  .then(({ user, auth_enabled }) => {
    if (auth_enabled && !user) {
      showLoginScreen();
      return;
    }
    if (user) applyProfile(user);
    startApp();
  })
  .catch(() => startApp()); // can't reach the server at all -- let the rest of the app surface that
