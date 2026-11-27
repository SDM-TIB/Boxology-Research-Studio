// --- Desk: the in-call window manager, stepper, and auto-arrange director --
//
// Ported from the sibling TIB-Chat-style reference project's "desk" pattern:
// floating macOS-style windows inside #desk-area, three pure layout
// functions (grid/split/focus), and a "director" that periodically decides
// which window is front and which layout fits best (app/director.py,
// Cloudflare Workers AI's clef-flash -- degrades to a fixed default when
// unconfigured, see applyDirectorDecision()). This file is a third plain
// <script> sharing app.js/editor.js's global scope (no bundler, see app.js's
// header comment), loaded after both.
//
// Scoped to calls only: the desk exists only while #voice-modal is open
// (attachCallPanels()/restoreCallPanels()), driven by live events off
// /api/tavus/live/{conversation_id} (deskHandleEvent(), wired in app.js's
// call-join code). Plain text chat keeps the existing fixed side panels.

const WM = { wins: new Map(), order: [], layout: "focus" };
let deskActive = false;

// front:true (default) brings the window to the prominent focus slot. Pass
// front:false for secondary windows (notes/results) that open in the
// background while a user turn is happening, so they don't yank the agent's
// primary window (graph/diagram/sources) out of focus every time the agent
// speaks or a row arrives.
function winOpen(id, title, { front = true } = {}) {
  let win = WM.wins.get(id);
  if (win) {
    if (title) win.titleEl.textContent = title;
    return win;
  }
  const el = document.createElement("div");
  el.className = "win";
  el.innerHTML = '<header><span class="lights"><i></i><i></i><i></i></span>'
    + '<span class="win-title"></span></header><div class="win-body"></div>';
  el.querySelector(".win-title").textContent = title || "";
  el.addEventListener("pointerdown", () => winFront(id));
  document.getElementById("desk-area").appendChild(el);
  win = { id, el, body: el.querySelector(".win-body"), titleEl: el.querySelector(".win-title") };
  WM.wins.set(id, win);
  WM.order.push(id);
  if (front) winFront(id); else winLayout();
  return win;
}

// The agent's primary window keeps the big focus slot unless the user
// explicitly clicks another one; called after secondary windows open.
let primaryWindowId = null;
function keepPrimaryFront() {
  if (primaryWindowId && WM.wins.has(primaryWindowId)) winFront(primaryWindowId);
}

function winClose(id) {
  const win = WM.wins.get(id);
  if (!win) return;
  win.el.remove();
  WM.wins.delete(id);
  WM.order = WM.order.filter((x) => x !== id);
  winLayout();
}

function winFront(id) {
  if (!WM.wins.has(id)) return;
  WM.order = [id, ...WM.order.filter((x) => x !== id)];
  for (const [winId, win] of WM.wins) win.el.classList.toggle("front", winId === id);
  winLayout();
}

// (index, total) -> {left%, top%, width%, height%}. index 0 is always the
// front-most window (winFront() keeps WM.order sorted that way).
const LAYOUTS = {
  grid(index, total) {
    const cols = total <= 1 ? 1 : 2;
    const rows = Math.ceil(total / cols);
    const col = index % cols, row = Math.floor(index / cols);
    return { left: (col * 100) / cols, top: (row * 100) / rows, width: 100 / cols, height: 100 / rows };
  },
  split(index, total) {
    if (total <= 1) return { left: 0, top: 0, width: 100, height: 100 };
    if (index === 0) return { left: 0, top: 0, width: 57, height: 100 };
    if (index === 1) return { left: 57, top: 0, width: 43, height: total <= 2 ? 100 : 64 };
    const rest = total - 2, slot = index - 2;
    return { left: 57 + (slot * 43) / rest, top: 64, width: 43 / rest, height: 36 };
  },
  focus(index, total) {
    if (index === 0) return { left: 0, top: 0, width: total > 1 ? 69 : 100, height: 100 };
    const rest = total - 1, slot = index - 1;
    return { left: 69, top: (slot * 100) / rest, width: 31, height: 100 / rest };
  },
};

function winLayout(layout) {
  if (layout && LAYOUTS[layout]) WM.layout = layout;
  const ids = WM.order;
  const fn = LAYOUTS[WM.layout] || LAYOUTS.focus;
  ids.forEach((id, i) => {
    const win = WM.wins.get(id);
    if (!win) return;
    const rect = fn(i, ids.length);
    win.el.style.left = rect.left + "%";
    win.el.style.top = rect.top + "%";
    win.el.style.width = rect.width + "%";
    win.el.style.height = rect.height + "%";
  });
}

// --- Inspector hook: renderGraphDetail() (app.js) calls this to find where
// to render a clicked node's detail. Used to open a separate floating
// "Inspector" desk window during a call; now always the inline panel that's
// already part of #graph-panel (and so already travels with it into the
// call desk's single Knowledge Graph window, see attachCallPanels()) -- one
// less floating box for the same information. ------------------------------

function graphDetailTarget() {
  document.getElementById("graph-detail").classList.remove("hidden");
  return document.getElementById("graph-detail-body");
}

// --- LINK / READ / RANK / WALK / SELECT stepper ---------------------------
// Maps onto Cartographer's existing SSE hop stages (no new backend event
// types): LINK <- hop{match,seed}, READ <- query (the SPARQL text itself
// being shown/"read"), RANK <- hop{rank}, WALK <- hop{hop1,hop2,expanded},
// SELECT <- hop{done}. A live Tavus call only ever gets `query`/
// `query_result` (not the finer-grained hop events text chat gets, since the
// webhook path runs one query directly rather than the full agentic loop),
// so during a call the stepper visibly jumps straight from idle to READ to
// SELECT -- expected, not a bug.
//
// One shared stepper, two mount points: the call desk (#stepper-card) and the
// plain-chat graph panel (#chat-stepper-card, see app.js's handleEvent "hop"
// case) render the identical traversal narration off the identical hop
// events -- rather than two divergent implementations, reset/advance update
// the progress/question text in both at once. Only the card for the surface
// actually in use is ever shown, though: showing both at once would be
// redundant once #chat-stepper-card is moved (with the rest of #graph-panel)
// into the call desk's own Knowledge Graph window, right next to the call's
// own #stepper-card overlay.

const STEPS = ["LINK", "READ", "RANK", "WALK", "SELECT"];
let stepperIndex = -1;

function resetStepper(question) {
  stepperIndex = -1;
  document.querySelectorAll(".stepper-step").forEach((el) => el.classList.remove("done", "active"));
  document.querySelectorAll(".stepper-question").forEach((el) => { el.textContent = question || ""; });
  document.getElementById("stepper-card")?.classList.toggle("hidden", !deskActive);
  document.getElementById("chat-stepper-card")?.classList.toggle("hidden", deskActive);
}

function advanceStepper(stage) {
  const idx = STEPS.indexOf(stage);
  if (idx < 0 || idx < stepperIndex) return;
  stepperIndex = idx;
  // Scoped per card (not one flat querySelectorAll(".stepper-step") over
  // both cards at once): with two cards' steps concatenated in document
  // order, a single 0..9 index against idx's 0..4 range would only ever
  // match the first card -- the second card's steps would never pick up
  // "done"/"active" at all.
  document.querySelectorAll(".stepper-card").forEach((card) => {
    card.querySelectorAll(".stepper-step").forEach((el, i) => {
      el.classList.toggle("done", i < idx);
      el.classList.toggle("active", i === idx);
    });
  });
}

function hopStageToStep(stage) {
  if (stage === "match" || stage === "seed") return "LINK";
  if (stage === "rank") return "RANK";
  if (stage === "hop1" || stage === "hop2" || stage === "expanded") return "WALK";
  if (stage === "done") return "SELECT";
  return null;
}

// --- Notes + results windows ------------------------------------------------

function addNote(text) {
  // WM.order is only non-empty for agents with a primary desk window
  // (cartographer/anvil, see AGENT_PRIMARY_WINDOW) -- Scholar's calls open
  // no windows at all, so notes shouldn't appear out of nowhere either.
  if (!deskActive || !text || WM.order.length === 0) return;
  const win = winOpen("notes", "Notes", { front: false });
  win.body.querySelector(".notes-empty")?.remove();
  const card = document.createElement("div");
  card.className = "note-card";
  card.textContent = text.length > 240 ? text.slice(0, 239) + "…" : text;
  win.body.prepend(card);
  keepPrimaryFront();
}

// Called the instant a new question starts (deskHandleEvent's "utterance"
// case), same moment text-chat's sendMessage() resets its own panels -- so a
// fresh question never shows the previous question's result while the new
// one is still being searched.
function clearSourcesWindow() {
  if (!deskActive) return;
  if (!primaryWindowId) primaryWindowId = "sources";
  const win = winOpen("sources", "Sources");
  winFront("sources");
  win.body.innerHTML = '<p class="notes-empty">Searching…</p>';
}

function renderSourcesWindow(query, sources) {
  if (!deskActive) return;
  // Scholar has no pre-opened primary panel, so its Sources window becomes
  // the primary one that keeps focus as the conversation continues.
  if (!primaryWindowId) primaryWindowId = "sources";
  const win = winOpen("sources", "Sources");
  winFront("sources");
  if (!sources || !sources.length) {
    win.body.innerHTML = '<p class="notes-empty">No sources found for that question.</p>';
    return;
  }
  win.body.innerHTML = "";
  if (query) {
    const q = document.createElement("div");
    q.className = "sources-query";
    q.textContent = query;
    win.body.appendChild(q);
  }
  for (const s of sources.slice(0, 8)) {
    const card = document.createElement("div");
    card.className = "note-card source-item";
    card.tabIndex = 0;
    card.title = "Click for details";
    const title = document.createElement("strong");
    title.textContent = s.doc_title || "Untitled";
    const meta = document.createElement("span");
    meta.className = "source-item-meta";
    const metaParts = [];
    if (s.page_no != null) metaParts.push(`p. ${s.page_no}`);
    if (typeof s.relevance === "number") metaParts.push(`${s.relevance}% match`);
    meta.textContent = metaParts.join(" · ");
    const snip = document.createElement("p");
    snip.textContent = (s.snippet || "").slice(0, 220);
    card.append(title, meta, snip);
    // Same citation-detail modal the text-chat Sources chips open (app.js) --
    // called directly with the full source object instead of the chat path's
    // data-citation lookup, since a call's sources aren't numbered citations
    // inside a message bubble.
    card.addEventListener("click", () => openCiteModal(s));
    win.body.appendChild(card);
  }
}

// --- Debug HUD + director polling ------------------------------------------

function renderDirectorDebug(data) {
  const hud = document.getElementById("debug-hud");
  if (!hud) return;
  if (!data || !data.available) { hud.classList.add("hidden"); return; }
  hud.classList.remove("hidden");
  const a = data.answers || {};
  const pct = (x) => (x == null ? null : Math.round(x * 100) + "%");
  const parts = [];
  if (a.front?.choice) {
    const confidence = pct(a.front.probability ?? a.front.confidence ?? a.front.score);
    parts.push(`front ${a.front.choice}${confidence ? " " + confidence : ""}`);
  }
  parts.push(`layout ${(a.layout && a.layout.choice) || WM.layout}`);
  for (const key of ["show_inspector", "show_notes"]) {
    const ans = a[key];
    if (!ans) continue;
    const confidence = pct(ans.probability ?? ans.confidence ?? ans.score);
    if (confidence) parts.push(`${key.replace("show_", "")} ${confidence}`);
  }
  document.getElementById("debug-hud-name").textContent = "clef-flash";
  document.getElementById("debug-hud-line").textContent = parts.join(" · ");
}

let directorTimer = null;
let directorBusy = false;
let lastUtterance = "";
let lastSpeaker = "";
let callPhase = "idle";

function startDirectorPolling() {
  stopDirectorPolling();
  pollDirector(); // don't leave the debug HUD/auto-arrange idle for the first 4s
  directorTimer = setInterval(pollDirector, 4000);
}

function stopDirectorPolling() {
  if (directorTimer) clearInterval(directorTimer);
  directorTimer = null;
  directorBusy = false;
}

async function pollDirector() {
  if (directorBusy || !deskActive) return;
  directorBusy = true;
  try {
    const state = {
      phase: callPhase, speaker: lastSpeaker, utterance: lastUtterance,
      open_windows: WM.order, front_window: WM.order[0] || null,
    };
    const response = await fetch("/api/director", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state),
    });
    applyDirectorDecision(await response.json());
  } catch (err) {
    renderDirectorDebug(null);
  }
  directorBusy = false;
}

// Only applies an answer above its confidence threshold (per the reference
// pattern); silently leaves the current arrangement alone otherwise -- never
// a hard failure, and with no Cloudflare credentials configured this never
// fires at all (decide() returns {available:false} up front).
function applyDirectorDecision(data) {
  renderDirectorDebug(data);
  if (!data || !data.available) return;
  const a = data.answers || {};
  const confidenceOf = (ans) => ans?.probability ?? ans?.confidence ?? ans?.score ?? 1;
  if (a.layout?.choice && confidenceOf(a.layout) >= 0.42) winLayout(a.layout.choice);
  if (a.front?.choice && WM.wins.has(a.front.choice) && confidenceOf(a.front) >= 0.38) winFront(a.front.choice);
}

// --- Call lifecycle: open/close the desk, route live events into it --------

const AGENT_PRIMARY_WINDOW = { cartographer: { id: "graph", title: "Knowledge Graph" },
  anvil: { id: "diagram", title: "Diagram" } };
const AGENT_PANEL_ID = { cartographer: "graph-panel", anvil: "boxology-panel" };

function attachCallPanels(agent) {
  // A maximized graph panel is a fixed-position overlay (app.js) -- reparenting
  // it into a desk window below while that class is still on would leave it
  // ignoring the window's box entirely and covering the whole page instead.
  closeGraphMaximize();
  const deskArea = document.getElementById("desk-area");
  deskArea.querySelectorAll(".win").forEach((el) => el.remove());
  WM.wins.clear();
  WM.order = [];
  deskActive = true;
  callPhase = "listening";
  // resetStepper("") already hides #chat-stepper-card here (deskActive is
  // true by this point) and un-hides #stepper-card -- but the call's own
  // card should stay hidden until there's an actual question to narrate, not
  // pop up empty the instant the call UI opens; the first user utterance
  // (deskHandleEvent's "utterance" case) calls resetStepper(event.text)
  // again and reveals it for real.
  resetStepper("");
  document.getElementById("stepper-card")?.classList.add("hidden");
  renderDirectorDebug(null);

  const primary = AGENT_PRIMARY_WINDOW[agent];
  const panelId = AGENT_PANEL_ID[agent];
  primaryWindowId = primary ? primary.id : null;
  if (primary && panelId) {
    const panel = document.getElementById(panelId);
    const win = winOpen(primary.id, primary.title);
    win.body.appendChild(panel);
    panel.style.display = "flex";
    // Land on Explore by default so the call opens showing the graph it's
    // about to narrate -- the tab switcher stays live, though (unlike before),
    // so the user can flip to Query mid-call to see the agent's own SPARQL
    // text and raw result rows, same as in text chat.
    if (agent === "cartographer") switchGraphViewTab("explore");
  }
  startDirectorPolling();
}

function restoreCallPanels() {
  stopDirectorPolling();
  deskActive = false;
  for (const panelId of Object.values(AGENT_PANEL_ID)) {
    const panel = document.getElementById(panelId);
    if (panel.parentElement?.classList.contains("win-body")) {
      document.querySelector(".chat-with-graph").appendChild(panel);
    }
    panel.style.display = AGENT_PANEL_ID[currentAgent] === panelId ? "flex" : "none";
  }
  document.getElementById("desk-area").querySelectorAll(".win").forEach((el) => el.remove());
  WM.wins.clear();
  WM.order = [];
}

// Routes one live-call SSE event (from /api/tavus/live/{id}, wired in
// app.js) into the desk: transcript, notes, stepper, graph, results.
function deskHandleEvent(event) {
  switch (event.type) {
    case "utterance":
      appendTranscriptLine(event.role, event.text);
      lastSpeaker = event.role;
      lastUtterance = event.text || lastUtterance;
      callPhase = event.role === "user" ? "listening" : "speaking";
      // The LINK/READ/RANK/WALK/SELECT stepper only models Cartographer's
      // graph walk -- it's meaningless for Scholar/Boxologist, so don't flash
      // it on their turns.
      if (event.role === "user" && currentAgent === "cartographer") resetStepper(event.text);
      // A fresh user question starts a fresh result, same as text-chat's
      // sendMessage() resetting these same panels on every send (app.js) --
      // without this, a call's graph/diagram/sources kept whatever the
      // *previous* question in this call had left behind: ingestSparqlResult
      // upserts onto the existing graph instead of replacing it, and the
      // other two panels just sat on stale content until a new result
      // happened to arrive (which, for Boxologist, depends on the pal
      // actually deciding to re-call the tool).
      if (event.role === "user") {
        if (currentAgent === "cartographer") resetGraph();
        else if (currentAgent === "anvil") resetBoxologyPreview();
        else if (currentAgent === "scholar") clearSourcesWindow();
      }
      // Cartographer already has the Live Transcript panel for this -- a
      // second floating Notes window repeating the same assistant text was
      // exactly the kind of redundant box this desk is trying to avoid.
      // Scholar/Boxologist have no transcript-adjacent summary, so they keep it.
      if (event.role === "assistant" && currentAgent !== "cartographer") addNote(event.text);
      break;
    case "query":
      lastSparqlQuery = event.query || lastSparqlQuery;
      advanceStepper("READ");
      appendTranscriptNote(event.query);
      break;
    case "hop": {
      const step = hopStageToStep(event.stage);
      if (step) advanceStepper(step);
      break;
    }
    case "query_result":
      if (event.error) {
        setWalkStatus(`Graph query failed: ${event.error}`);
        document.getElementById("query-error").textContent = event.error;
        document.getElementById("query-error").classList.remove("hidden");
        break;
      }
      advanceStepper("SELECT");
      // Mirrors into the Query tab (editor text + results table) in the same
      // single Knowledge Graph window, instead of a separate "Query results"
      // box -- the user can flip to that tab mid-call to see it; no forced
      // tab switch here, so it doesn't yank them back to Explore if they did.
      presentQueryResult(lastSparqlQuery, event.vars, event.rows, `${event.rows.length} row(s) — from Cartographer's own query`);
      ingestSparqlResult(event.vars, event.rows);
      break;
    case "sources":
      renderSourcesWindow(event.query, event.sources);
      break;
    case "plan":
      if (!event.boxology_file) {
        const diagram = winOpen("diagram", "Diagram");
        winFront("diagram");
        diagram.body.innerHTML = `<p class="graph-empty">${escapeHtml(event.error || "No diagram was returned.")}</p>`;
        break;
      }
      editorDiagram = event.boxology_file || null;
      renderBoxologyPlan(event);
      winFront("diagram");
      break;
    case "call_ended":
      callPhase = "ended";
      break;
  }
}
