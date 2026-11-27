// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright package.
// Exercises the real Tavus/Daily.co video call flow end to end (mocked: a
// fake window.Daily + the /api/tavus/* endpoints), the desk window manager
// (graph/diagram panel reparenting, stepper, Cartographer's single-window
// Explore/Query tabs, Scholar's notes/sources), and the text-chat path
// (unaffected by the call rework).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const root = path.resolve(__dirname, "../app/static");

const SAMPLE_BOXOLOGY_FILE = {
  class: "GraphLinksModel",
  modelData: { boxologyId: "test-system", boxologyLabel: "Test System" },
  nodeDataArray: [
    { key: "g1", isGroup: true, category: "ClusterGroup", label: "1c Rule Base" },
    { key: "d1", name: "Data", label: "Input", shape: "Rectangle", color: "#c4e8ffff", stroke: "#1E5F8B", loc: "0 0", width: 100, height: 50, group: "g1" },
    { key: "p1", name: "Deduce", label: "Classify", shape: "RoundedRectangle", color: "#ffcdcd", stroke: "#4c003bff", loc: "200 0", width: 100, height: 50, group: "g1" },
  ],
  linkDataArray: [{ from: "d1", to: "p1" }],
};

const SPARQL_QUERY = "PREFIX t4b: <http://tool4boxology.org/>\nSELECT ?rule WHERE { ?rule a t4b:Rule . } LIMIT 5";
const SPARQL_ROWS = [{ rule: { type: "uri", value: "http://tool4boxology.org/Rule/rule_1" } }];

// Text-chat SSE fixtures (unaffected by the call rework).
const CHAT_SSE = {
  scholar: [
    { type: "text", text: "Scholar's answer." },
    { type: "sources", sources: [{ citation: 1, doc_title: "Neuro-fuzzy CDS", page_no: 3, snippet: "A hybrid neuro-symbolic approach to clinical decision support." }] },
    { type: "done" },
  ],
  anvil: [
    { type: "tool_call", name: "generate_boxology" },
    { type: "plan", valid: true, problems: [], boxology_file: SAMPLE_BOXOLOGY_FILE, semantic_file: { ok: true } },
    { type: "text", text: "Generated and validated." },
    { type: "done" },
  ],
  cartographer: [
    { type: "hop", stage: "match" },
    { type: "hop", stage: "rank" },
    { type: "query", query: SPARQL_QUERY },
    { type: "query_result", vars: ["rule"], rows: SPARQL_ROWS },
    { type: "text", text: "There is one rule." },
    { type: "done" },
  ],
};

// Live-call SSE fixtures (/api/tavus/live/{conversation_id}).
const LIVE_SSE = {
  scholar: [
    { type: "utterance", role: "user", text: "Hello scholar" },
    { type: "sources", query: "clinical decision support", sources: [
      { title: "Neuro-fuzzy CDS", page: 3, snippet: "A hybrid neuro-symbolic approach to clinical decision support." },
    ] },
    { type: "utterance", role: "assistant", text: "Scholar's spoken answer." },
  ],
  anvil: [
    { type: "utterance", role: "user", text: "Hello anvil" },
    { type: "plan", boxology_file: SAMPLE_BOXOLOGY_FILE, valid: true, problems: [] },
    { type: "utterance", role: "assistant", text: "Anvil's spoken answer." },
  ],
  cartographer: [
    { type: "utterance", role: "user", text: "Hello cartographer" },
    { type: "query", query: SPARQL_QUERY },
    { type: "query_result", vars: ["rule"], rows: SPARQL_ROWS },
    { type: "utterance", role: "assistant", text: "Cartographer's spoken answer." },
  ],
};

function sseBody(events) {
  return events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("");
}

// Clicks a "Save output" button and collects the file(s) it downloads (Save
// may emit a Markdown file plus, for Cartographer, a graph .svg), returning
// [{ name, body }]. `expected` is how many downloads to wait for.
async function captureDownloads(page, action, expected) {
  const pending = [];
  const handler = (d) => pending.push(d);
  page.on("download", handler);
  await action();
  const start = Date.now();
  while (pending.length < expected && Date.now() - start < 4000) await page.waitForTimeout(100);
  page.off("download", handler);
  const out = [];
  for (const d of pending) {
    const stream = await d.createReadStream();
    let body = "";
    for await (const chunk of stream) body += chunk;
    out.push({ name: d.suggestedFilename(), body });
  }
  return out;
}

// Shared by both servers below (the main one and the login sub-test's own) --
// serves app/static as-is, so a login-screen change can't silently diverge
// from what the main flow already renders.
function serveStaticFile(pathname, res) {
  const named = {
    "/": "index.html", "/app.js": "app.js", "/editor.js": "editor.js",
    "/desk.js": "desk.js", "/style.css": "style.css", "/save_output.js": "save_output.js",
  }[pathname];
  const file = named || (pathname.startsWith("/images/") ? pathname.slice(1) : null);
  if (!file || !fs.existsSync(path.join(root, file))) { res.writeHead(404).end(); return; }
  const type = file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css"
    : file.endsWith(".png") ? "image/png" : file.endsWith(".webp") ? "image/webp"
    : file.endsWith(".jpg") || file.endsWith(".jpeg") ? "image/jpeg" : "text/html";
  res.setHeader("Content-Type", type);
  res.end(fs.readFileSync(path.join(root, file)));
}

(async () => {
  const calls = {}; // conversation_id -> agent, for routing /api/tavus/live
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;

    const chatMatch = pathname.match(/^\/api\/chat\/(scholar|anvil|cartographer)$/);
    if (chatMatch) {
      res.setHeader("Content-Type", "text/event-stream");
      res.end(sseBody(CHAT_SSE[chatMatch[1]]));
      return;
    }
    const startMatch = pathname.match(/^\/api\/tavus\/start_call\/(scholar|anvil|cartographer)$/);
    if (startMatch && req.method === "POST") {
      const agent = startMatch[1];
      const conversationId = "conv-" + agent;
      calls[conversationId] = agent;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        conversation_url: "https://fake.daily.co/" + conversationId,
        conversation_id: conversationId, meeting_token: null, end_token: "tok-" + agent,
      }));
      return;
    }
    const liveMatch = pathname.match(/^\/api\/tavus\/live\/(.+)$/);
    if (liveMatch) {
      const agent = calls[liveMatch[1]];
      res.setHeader("Content-Type", "text/event-stream");
      res.end(sseBody([...(LIVE_SSE[agent] || []), { type: "call_ended" }]));
      return;
    }
    if (pathname === "/api/tavus/end_call" && req.method === "POST") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (pathname === "/api/director" && req.method === "POST") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ available: false }));
      return;
    }
    if (pathname === "/api/sparql/node") {
      // Backs auto-reveal of neighbors + literal-node expansion (?uri= or ?label=).
      // object_label/subject_label mirror what describe_neighbors() (sparql_store.py)
      // now resolves for each neighbor -- without them the graph panel falls back to
      // the raw URI slug ("dp_1"/"bx_1"), which is the exact bug being tested for.
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        uri: "http://tool4boxology.org/Component/node_1", label: "Node 1",
        outgoing: [{ predicate: "http://tool4boxology.org/hasPattern", object: "http://tool4boxology.org/DesignPattern/dp_1", object_is_uri: true, object_label: "Elementary Deduce" }],
        incoming: [{ subject: "http://tool4boxology.org/Boxology/bx_1", predicate: "http://tool4boxology.org/hasProcess", subject_label: "Example Boxology" }],
      }));
      return;
    }
    if (pathname === "/api/sparql/schema") {
      // Backs the graph panel's home/entry view (class bubbles).
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ classes: [
        { type: "http://tool4boxology.org/Rule", label: "Rule", count: 5 },
        { type: "http://tool4boxology.org/DesignPattern", label: "DesignPattern", count: 2 },
      ] }));
      return;
    }
    if (pathname === "/api/sparql/search") {
      // Backs the graph panel's search box.
      const q = (new URL(req.url, "http://localhost").searchParams.get("q") || "").toLowerCase();
      const all = [
        { id: "http://tool4boxology.org/DesignPattern/dp_1", label: "Elementary Deduce", kind: "pattern" },
        { id: "http://tool4boxology.org/Component/node_1", label: "Node 1", kind: "component" },
      ];
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ results: all.filter((e) => e.label.toLowerCase().includes(q)) }));
      return;
    }
    if (pathname === "/api/sparql/node/groups") {
      // A count (9) above showExpandGroups()'s own small-node cutoff (6), so
      // the grouped-expand UI (not the flat fallback) is what gets exercised.
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ uri: "http://tool4boxology.org/Component/node_1", groups: [
        { predicate: "http://tool4boxology.org/hasInput", label: "hasInput", direction: "out", count: 9 },
      ] }));
      return;
    }
    if (pathname === "/api/sparql/node/neighbors") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        items: [{ id: "http://tool4boxology.org/Component/node_2", label: "Node 2", kind: "component" }],
        total: 9, offset: 0, limit: 25,
      }));
      return;
    }
    if (pathname === "/api/sparql" && req.method === "POST") {
      // Backs the home view's class-bubble click and the Query tab's Run
      // button -- a fixed fixture result exercises the plumbing; the real
      // query engine's own behavior is covered directly against
      // app/sparql_store.py, not through this browser harness.
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          vars: ["s", "label"],
          rows: [{ s: { type: "uri", value: "http://tool4boxology.org/DesignPattern/dp_1" }, label: { type: "literal", value: "Elementary Deduce" } }],
        }));
      });
      return;
    }
    if (pathname === "/api/anvil/status") {
      // Anvil tab polls this for the GPU-readiness badge; report ready.
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ready: true, state: "ready" }));
      return;
    }
    if (pathname === "/api/usage") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        modal: { available: true, metered_cost: 1.23, credits_used: 1.0, billed_cost: 0 },
        tavus: { available: true, minutes_used: 5, conversations_counted: 3 },
      }));
      return;
    }
    if (pathname === "/api/auth/me") {
      // Auth off for the main flow below -- it already covers every agent's
      // chat/call/save behavior unauthenticated; the login screen itself gets
      // its own focused sub-test (a separate server, auth on) further down.
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ user: null, auth_enabled: false }));
      return;
    }
    serveStaticFile(pathname, res);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    // Resource-load failures for the deliberately aborted CDN requests (d3,
    // Daily.co) are expected noise, not an app defect -- only count
    // unrelated console errors.
    page.on("console", msg => { if (msg.type() === "error" && !/d3\.min\.js|daily-js|daily\.js|ERR_FAILED/.test(msg.text())) errors.push(msg.text()); });
    await page.route("**/daily-js@*/dist/daily.js", route => route.abort());
    // force-graph's own CDN is deliberately left reachable here (unlike
    // daily-js above) -- the main flow below needs the real <canvas> it
    // draws into #graph-canvas to exercise the actual PNG export, not the
    // no-ForceGraph fallback. See the dedicated graph-CDN-unavailable check
    // near the end of this file for that fallback path instead.

    // Minimal fake window.Daily -- a real WebRTC connection can't run in this
    // harness, so this stands in for window.Daily.createCallObject(), firing
    // "joined-meeting" shortly after join() the same way a real room would.
    await page.addInitScript(() => {
      window.__dailyJoins = [];
      function MockCall() {
        this._handlers = {};
        this.localAudio = true;
        this.localVideo = true;
      }
      MockCall.prototype.on = function (event, cb) {
        (this._handlers[event] = this._handlers[event] || []).push(cb);
        return this;
      };
      MockCall.prototype.join = function (opts) {
        window.__dailyJoins.push(opts);
        setTimeout(() => (this._handlers["joined-meeting"] || []).forEach((cb) => cb({})), 5);
        return Promise.resolve();
      };
      MockCall.prototype.leave = function () { return Promise.resolve(); };
      MockCall.prototype.destroy = function () {};
      MockCall.prototype.setLocalAudio = function (v) { this.localAudio = v; };
      MockCall.prototype.setLocalVideo = function (v) { this.localVideo = v; };
      window.Daily = { createCallObject: () => new MockCall() };
    });

    await page.goto("http://127.0.0.1:" + server.address().port);
    // App now lands on the Overview dashboard; the chat workspace is a view.
    await page.locator("#view-overview.visible").waitFor();
    assert.ok((await page.locator("#overview-assistants .assistant-tile").count()) === 3,
      "overview shows three assistant tiles");
    await page.locator('.nav-item[data-view="assistants"]').click();
    await page.locator("#chat-view.visible .welcome").waitFor();
    const screenshot = path.join(os.tmpdir(), "boxology-light-desktop.png");
    await page.screenshot({ path: screenshot, fullPage: true });

    for (const agent of ["scholar", "anvil", "cartographer"]) {
      if (agent !== "scholar") await page.locator('[data-agent="' + agent + '"]').click();
      const before = await page.locator("#messages").innerText();
      const joinsBefore = await page.evaluate(() => window.__dailyJoins.length);

      // Simulate the exact scenario that used to hide the graph entirely
      // during a call: Query left active from an earlier text-chat session.
      if (agent === "cartographer") await page.locator("#graph-tab-query").click();

      await page.locator("#start-call").click();
      await page.waitForFunction(() => document.querySelector("#voice-modal").open);
      assert.equal(await page.locator(".agent-card.active").getAttribute("data-agent"), agent);
      await page.waitForFunction((n) => window.__dailyJoins.length > n, joinsBefore, { timeout: 5000 });
      assert.match(await page.evaluate((n) => window.__dailyJoins[n].url, joinsBefore), /fake\.daily\.co/,
        "Daily.createCallObject().join() must be called with the room URL from start_call");

      await page.waitForFunction(() => document.querySelectorAll(".transcript-line").length >= 2, { timeout: 5000 });
      const lines = await page.locator(".transcript-line").allInnerTexts();
      assert.match(lines[0], /Hello/);
      assert.ok(lines[1].length > 0, "assistant transcript line must have text");

      if (agent === "cartographer") {
        assert.equal(await page.locator("#desk-area .win .win-body #graph-panel").count(), 1,
          "graph panel must move into a desk window for Cartographer");
        // Only one desk window for Cartographer -- the old separate "Query
        // results" and "Inspector" boxes are gone (folded into this panel's
        // own Query tab / inline detail view), so there's nothing else to clutter
        // the call with.
        assert.equal(await page.locator("#desk-area .win").count(), 1,
          "Cartographer's call desk must show a single window, not a scatter of boxes");
        // Query was left active (above) before this call started -- docking
        // into the desk window still lands on Explore by default (so the call
        // opens showing the graph it's about to narrate), but unlike before,
        // the tab switcher stays reachable the whole time -- the single window
        // now has the full desk area to itself, so Query has room to render.
        assert.equal(await page.locator("#graph-explore-view:not(.hidden)").count(), 1,
          "docking into the call desk must land on the Explore tab by default");
        assert.notEqual(await page.locator("#desk-area .graph-view-tabs").evaluate((el) => getComputedStyle(el).display), "none",
          "the Explore/Query tab switcher must stay reachable while docked in the call desk");
        // During a call, the query event is relayed to the transcript (not
        // the .sparql-note chat styling, which is only for the text-chat
        // message container) -- see deskHandleEvent()'s "query" case.
        await page.locator(".transcript-note", { hasText: "t4b:" }).first().waitFor({ timeout: 5000 });
        await page.waitForFunction(() => document.querySelectorAll(".results-table tbody tr").length >= 1, { timeout: 5000 });
        // The auto-revealed neighbor (dp_1, via the mocked /api/sparql/node
        // fixture) must show its resolved rdfs:label ("Elementary Deduce"),
        // not the raw URI slug "dp_1" -- the bug reported from this exact
        // call view (describe_neighbors() now resolves every neighbor's own
        // label, not just the expanded node's).
        await page.waitForFunction(
          () => graphNodes.some((n) => n.id === "http://tool4boxology.org/DesignPattern/dp_1" && n.label === "Elementary Deduce"),
          { timeout: 5000 },
        );
        // Selecting a node shows its detail card without needing to scroll the
        // desk window to find it -- it floats over the bottom of the canvas
        // (position:absolute, see style.css's .graph-detail) rather than
        // pushing the canvas up and growing the panel's total content height
        // past the window's box, which is what made it look like it "didn't
        // appear" in the much shorter call-desk window (vs. the tall chat sidebar).
        await page.evaluate(() => navigateToNode("http://tool4boxology.org/DesignPattern/dp_1"));
        await page.locator("#graph-detail:not(.hidden)").waitFor({ timeout: 5000 });
        assert.equal(await page.locator("#desk-area .win-body").evaluate((el) => el.scrollHeight <= el.clientHeight + 2), true,
          "selecting a node must not make the call desk window scrollable just to see its detail");
        // Switching to the Query tab mid-call shows Cartographer's own query
        // text and result rows -- no separate "Query results" window needed,
        // and switching doesn't require leaving/rejoining the call.
        await page.locator("#graph-tab-query").click();
        await page.locator("#graph-query-view:not(.hidden)").waitFor({ timeout: 5000 });
        assert.match(await page.locator("#query-editor").inputValue(), /t4b:Rule/,
          "Query tab shows Cartographer's own SPARQL text, not just a blank editor");
        assert.match(await page.locator("#query-meta").innerText(), /Cartographer's own query/);
        await page.locator("#graph-tab-explore").click(); // back to Explore for the rest of the flow
        // Scoped to #stepper-card specifically (not a bare ".stepper-step"
        // query across both cards): advanceStepper() used to index into the
        // flattened NodeList of both cards' steps at once, so only whichever
        // card happened to come first in the DOM would ever show progress --
        // this pins down the call's own card, wherever document order puts it.
        assert.equal(await page.locator("#stepper-card .stepper-step.active, #stepper-card .stepper-step.done").count() > 0, true,
          "the call's own stepper must have advanced past idle");
        // Only one stepper is shown at a time -- #chat-stepper-card (moved,
        // with the rest of #graph-panel, into this same call desk window)
        // must stay hidden while the call's own #stepper-card is in use,
        // not show a redundant second copy of the same narration.
        assert.equal(await page.locator("#chat-stepper-card.hidden").count(), 1,
          "chat stepper card must stay hidden during a call");
        // The graph panel (and its "PNG ↓" button) moved into the desk window
        // along with the rest of #graph-panel -- same element, same listener,
        // just relocated, so it must still work from inside the call.
        await page.waitForFunction(() => !!document.querySelector("#graph-canvas canvas"), { timeout: 5000 });
        const deskDirectPng = await captureDownloads(page, () => page.locator("#graph-download-png").click(), 1);
        assert.match(deskDirectPng[0].body.slice(0, 16), /PNG/, "PNG button works once relocated into the call desk");
        // "Save output" in the call exports the transcript + query results + graph PNG.
        const deskSave = await captureDownloads(page, () => page.locator("#save-desk-output").click(), 2);
        const deskMd = deskSave.find((f) => f.name.endsWith(".md"));
        const deskPng = deskSave.find((f) => f.name.endsWith(".png"));
        assert.equal(deskMd.name, "cartographer-call-session.md");
        assert.match(deskMd.body, /## Transcript/);
        assert.match(deskMd.body, /## Query results/);
        assert.match(deskMd.body, /\| rule \|/, "query-results table has the SPARQL var as a column");
        assert.ok(deskPng, "call-mode save includes the graph as a PNG, same as text chat");
        assert.equal(deskPng.name, "cartographer-call-session-graph.png");
      }
      if (agent === "anvil") {
        assert.equal(await page.locator("#desk-area .win .win-body #boxology-panel").count(), 1,
          "boxology preview panel must move into a desk window for Boxologist");
        await page.waitForFunction(() => document.querySelectorAll("#boxology-canvas .bshape").length >= 2, { timeout: 5000 });
        await page.waitForFunction(() => document.querySelectorAll("#boxology-canvas .blink").length >= 1, { timeout: 5000 });
        // Boxologist's own diagram-PNG download, also relocated into the desk.
        const deskBoxPng = await captureDownloads(page, () => page.locator("#boxology-download-png").click(), 1);
        assert.match(deskBoxPng[0].body.slice(0, 16), /PNG/, "diagram PNG button works once relocated into the call desk");
      }
      if (agent === "scholar") {
        // A "sources" live event opens a Sources window so Scholar calls show
        // their retrieved results too (not just the spoken answer).
        await page.locator("#desk-area .win .source-item strong", { hasText: "Neuro-fuzzy CDS" })
          .first().waitFor({ timeout: 5000 });
        // "Save output" in the call (ai-assist) exports the transcript + sources.
        const deskSave = await captureDownloads(page, () => page.locator("#save-desk-output").click(), 1);
        assert.equal(deskSave.length, 1, "Scholar call save produces one file");
        assert.equal(deskSave[0].name, "scholar-call-session.md");
        assert.match(deskSave[0].body, /## Transcript/);
        assert.match(deskSave[0].body, /## Sources/);
        assert.match(deskSave[0].body, /Neuro-fuzzy CDS/);
      }

      await page.locator("#close-voice").click();
      await page.waitForFunction(() => !document.querySelector("#voice-modal").open);
      assert.equal(await page.locator("#messages").innerText(), before, "a call must not alter the visible text-chat transcript");
      if (agent === "cartographer") {
        assert.equal(await page.locator(".chat-with-graph > #graph-panel").count(), 1, "graph panel must return to the chat view on close");
      }
      if (agent === "anvil") {
        assert.equal(await page.locator(".chat-with-graph > #boxology-panel").count(), 1, "boxology panel must return to the chat view on close");
      }
    }

    // Text-chat path (not a call): plan event must render an inline download
    // chip in the chat message itself, matching Scholar's source-chip pattern.
    await page.locator('[data-agent="anvil"]').click();
    await page.locator("#input").fill("Design a simple classifier");
    await page.locator("#send").click();
    await page.locator(".plan-chip", { hasText: "Download .boxology" }).waitFor({ timeout: 5000 });
    // The preview panel's own download links are separate elements from the
    // in-chat chip, and only get their href at the end of renderBoxologyPlan's
    // async staged-reveal animation -- .plan-chip appears instantly (it's
    // synchronous), so wait for the actual href, not just the chip.
    await page.waitForFunction(() => {
      const href = document.getElementById("boxology-download")?.getAttribute("href");
      return !!href && href.startsWith("blob:");
    }, { timeout: 8000 });
    const panelDownloadHref = await page.locator("#boxology-download").getAttribute("href");
    assert.ok(panelDownloadHref && panelDownloadHref.startsWith("blob:"), "panel download link must have a real blob href");
    const semanticDownloadHref = await page.locator("#boxology-download-semantic").getAttribute("href");
    assert.ok(semanticDownloadHref && semanticDownloadHref.startsWith("blob:"), "panel semantic-download link must have a real blob href");
    await page.waitForFunction(() => document.querySelectorAll("#boxology-canvas .blink").length >= 1, { timeout: 5000 });

    // Boxology diagram -> PNG, from the panel's own dedicated download link
    // (rasterizes the real, already-animated #boxology-canvas SVG).
    const boxologyPng = await captureDownloads(page, () => page.locator("#boxology-download-png").click(), 1);
    assert.equal(boxologyPng[0].name, "test-system.png");
    assert.match(boxologyPng[0].body.slice(0, 16), /PNG/, "downloaded file is a real PNG (magic bytes present)");

    // --- "Save output" in text chat (prompting) -------------------------------
    // Every agent gets this, in both chat and call mode, the same way --
    // Boxologist additionally has its own dedicated diagram downloads above,
    // but that's extra, not a substitute for saving the conversation text.
    assert.equal(await page.locator("#save-output").isVisible(), true, "Save output is available for Boxologist too");
    const anvilSave = await captureDownloads(page, () => page.locator("#save-output").click(), 1);
    assert.equal(anvilSave[0].name, "anvil-session.md", "Boxologist save -> anvil-session.md");
    assert.match(anvilSave[0].body, /Design a simple classifier/, "Boxologist save includes the conversation text");

    // --- My projects (no session here -- browser-local storage fallback) -----
    // The generated diagram (+ its semantic JSON) must ride along with the
    // saved project, not just the chat transcript -- "all format they
    // generated, e.g. image of diagram in boxologist".
    await page.locator("#save-project").click();
    await page.locator("#app-toast.show", { hasText: "saved in this browser" }).waitFor({ timeout: 5000 });
    await page.locator('.nav-item[data-view="projects"]').click();
    await page.locator(".project-row").first().waitFor({ timeout: 5000 });
    assert.equal(await page.locator(".project-row-thumb").count(), 1, "a saved Boxologist project shows its diagram as a thumbnail");
    const savedLocally = await page.evaluate(() => JSON.parse(localStorage.getItem("boxology.projects.v1")));
    assert.equal(savedLocally.length, 1);
    assert.ok(savedLocally[0].artifacts.diagramPng?.startsWith("data:image/png"), "the diagram PNG is captured as a data URL");
    assert.ok(savedLocally[0].artifacts.boxologyFile, "the .boxology JSON is captured too");
    assert.ok(savedLocally[0].artifacts.semanticFile, "the semantic JSON is captured too");

    // Re-opening restores the diagram via the same renderer a live plan uses.
    await page.locator(".project-row .secondary-button", { hasText: "Continue" }).click();
    await page.locator("#chat-view.visible").waitFor({ timeout: 5000 });
    await page.waitForFunction(() => document.querySelectorAll("#boxology-canvas .bshape").length >= 2, { timeout: 5000 });

    // Deleting removes it from the list and from localStorage.
    await page.locator('.nav-item[data-view="projects"]').click();
    await page.locator(".project-delete").click();
    await page.waitForFunction(() => document.querySelectorAll(".project-row").length === 0, { timeout: 5000 });
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("boxology.projects.v1"))).length, 0);
    await page.locator('.nav-item[data-view="assistants"]').click();

    // Scholar: Markdown with the answer + cited sources.
    await page.locator('[data-agent="scholar"]').click();
    await page.locator("#save-output").waitFor({ state: "visible" });
    await page.locator("#input").fill("What is clinical decision support?");
    await page.locator("#send").click();
    await page.locator(".msg.assistant .sources .source-chip").first().waitFor({ timeout: 5000 });
    const scholarSave = await captureDownloads(page, () => page.locator("#save-output").click(), 1);
    assert.equal(scholarSave[0].name, "scholar-session.md", "Scholar save -> scholar-session.md");
    assert.match(scholarSave[0].body, /Scholar's answer\./);
    assert.match(scholarSave[0].body, /\*\*Sources\*\*/);
    assert.match(scholarSave[0].body, /Neuro-fuzzy CDS p\.3/);

    // Cartographer: Markdown with the answer + SPARQL query, plus the live
    // knowledge-graph canvas (the real force-graph render, not a fake-DOM
    // stand-in -- the CDN is left reachable for this whole test, see the top).
    await page.locator('[data-agent="cartographer"]').click();
    await page.locator("#input").fill("List the rules");
    await page.locator("#send").click();
    await page.locator(".msg.assistant .hops.sparql-note").first().waitFor({ timeout: 5000 });
    await page.waitForFunction(() => !!document.querySelector("#graph-canvas canvas"), { timeout: 5000 });

    // The plain-chat graph panel gets the same LINK/READ/RANK/WALK/SELECT
    // stepper the call desk shows (desk.js's resetStepper/advanceStepper,
    // shared -- see app.js's handleEvent "hop" case), not just a silently
    // dropped "hop" event.
    assert.equal(await page.locator("#chat-stepper-card:not(.hidden)").count(), 1,
      "chat stepper card must be visible for Cartographer's text-chat path");
    assert.equal(
      await page.locator("#chat-stepper-card .stepper-step.active, #chat-stepper-card .stepper-step.done").count() > 0,
      true, "chat stepper must advance past idle from the SSE hop/query/query_result events");

    // Direct unit check of advanceStepper()'s indexing, independent of which
    // of the two real cards happens to come first in the page's actual DOM
    // order: a synthetic second ".stepper-card" is added here specifically
    // so its steps are NOT first in querySelectorAll(".stepper-step") order
    // -- advanceStepper() must still mark ITS steps done/active by indexing
    // within each card (card.querySelectorAll(...)), not by a single flat
    // index across every card's steps concatenated together.
    const secondCardAdvanced = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.className = "stepper-card";
      probe.innerHTML = `<p class="stepper-question"></p>
        <div class="stepper-track">
          <span class="stepper-step" data-step="LINK"></span>
          <span class="stepper-step" data-step="READ"></span>
          <span class="stepper-step" data-step="RANK"></span>
          <span class="stepper-step" data-step="WALK"></span>
          <span class="stepper-step" data-step="SELECT"></span>
        </div>`;
      document.body.appendChild(probe); // appended last -> its steps are last in document order
      resetStepper("probe");
      advanceStepper("RANK");
      const steps = Array.from(probe.querySelectorAll(".stepper-step"));
      const result = steps.map((el) => el.classList.contains("done") || el.classList.contains("active"));
      probe.remove();
      return result;
    });
    assert.deepEqual(secondCardAdvanced, [true, true, true, false, false],
      "advanceStepper must update a card's steps by their index within that card, " +
      "not by a flat index across every stepper-card's steps combined");

    // The dedicated "PNG ↓" button in the graph panel itself.
    const directPng = await captureDownloads(page, () => page.locator("#graph-download-png").click(), 1);
    assert.match(directPng[0].name, /^cartographer-graph\.png$/);
    assert.match(directPng[0].body.slice(0, 16), /PNG/, "downloaded file is a real PNG (magic bytes present)");

    // The bundled "Save output" button: Markdown plus the same graph PNG.
    const cartoSave = await captureDownloads(page, () => page.locator("#save-output").click(), 2);
    const cartoMd = cartoSave.find((f) => f.name.endsWith(".md"));
    const cartoPng = cartoSave.find((f) => f.name.endsWith(".png"));
    assert.equal(cartoMd.name, "cartographer-session.md");
    assert.match(cartoMd.body, /There is one rule\./);
    assert.match(cartoMd.body, /```sparql[\s\S]*t4b:Rule/);
    assert.ok(cartoPng, "Cartographer save includes the graph as a PNG");
    assert.equal(cartoPng.name, "cartographer-session-graph.png");
    assert.match(cartoPng.body.slice(0, 16), /PNG/, "downloaded file is a real PNG (magic bytes present)");

    // --- Explorer: home/entry view, search, breadcrumbs, grouped expand, query tab ---

    // Home/entry view: an empty canvas must show class bubbles from
    // /api/sparql/schema instead of the bare "Ask a question..." text.
    await page.evaluate(() => resetGraph());
    await page.locator(".graph-entry-bubble").first().waitFor({ timeout: 5000 });
    assert.equal(await page.locator(".graph-entry-bubble").count(), 2, "home view shows one bubble per class from /api/sparql/schema");
    await page.locator(".graph-entry-bubble", { hasText: "DesignPattern" }).click();
    await page.waitForFunction(() => graphNodes.length > 0, { timeout: 5000 });
    assert.equal(await page.evaluate(() => graphNodes[0].label), "Elementary Deduce",
      "clicking a class bubble loads its instances onto the canvas");

    // Search: a label substring must list matches from /api/sparql/search;
    // picking one adds/selects it and starts the breadcrumb + deep-link trail.
    await page.locator("#graph-search-input").fill("Node 1");
    await page.locator(".graph-search-result").first().waitFor({ timeout: 5000 });
    await page.locator(".graph-search-result").first().click();
    await page.locator("#graph-detail:not(.hidden)").waitFor({ timeout: 5000 });
    assert.match(await page.locator("#graph-detail-body").innerText(), /Node 1/);
    assert.equal(await page.locator("#graph-breadcrumbs:not(.hidden)").count(), 1, "selecting a search result starts a breadcrumb trail");
    assert.equal(await page.locator(".graph-breadcrumb-chip").count(), 1);
    assert.match(await page.evaluate(() => location.hash), /^#cartographer:node:/, "selecting a node updates the URL deep link");

    // Grouped expand: the /api/sparql/node/groups fixture reports 9 hasInput
    // neighbors (above showExpandGroups()'s small-node cutoff of 6), so
    // "Expand neighbors" must offer a per-predicate group button, not a flat dump.
    await page.locator("#graph-detail-body button", { hasText: "Expand neighbors" }).click();
    await page.locator("#graph-detail-body button", { hasText: "hasInput" }).waitFor({ timeout: 5000 });
    await page.locator("#graph-detail-body button", { hasText: "hasInput" }).click();
    await page.waitForFunction(() => graphNodes.some((n) => n.label === "Node 2"), { timeout: 5000 });

    // Breadcrumbs: a second manual navigation adds a second chip; Back returns to the first node.
    await page.evaluate(() => navigateToNode("http://tool4boxology.org/Component/node_2"));
    assert.equal(await page.locator(".graph-breadcrumb-chip").count(), 2, "a second manual navigation adds a second breadcrumb chip");
    await page.locator("#graph-nav-back").click();
    assert.equal(await page.evaluate(() => selectedNodeId), "http://tool4boxology.org/Component/node_1",
      "the Back button returns to the previously visited node");

    // Query view tab: a hand-written query can be run, shown on the graph, and exported.
    await page.locator("#graph-tab-query").click();
    await page.locator("#query-editor").fill("SELECT ?s ?label WHERE { ?s a <http://tool4boxology.org/DesignPattern> } LIMIT 5");
    await page.locator("#query-run").click();
    await page.locator("#query-results-table tbody tr").first().waitFor({ timeout: 5000 });
    assert.match(await page.locator("#query-meta").innerText(), /row\(s\)/);
    const queryCsv = await captureDownloads(page, () => page.locator("#query-export-csv").click(), 1);
    assert.match(queryCsv[0].body, /Elementary Deduce/, "CSV export includes the query's own result rows");
    await page.locator("#query-show-on-graph").click();
    assert.equal(await page.locator("#graph-tab-explore.active").count(), 1, "Show on graph switches back to the Explore tab");
    await page.waitForFunction(() => graphNodes.length > 0, { timeout: 5000 });

    // Deep link: loading the app directly with a "#cartographer:node:..." hash
    // must land on the Cartographer tab with that node already resolved and shown.
    await page.goto("http://127.0.0.1:" + server.address().port
      + "/#cartographer:node:" + encodeURIComponent("http://tool4boxology.org/Component/node_1"));
    await page.locator("#graph-detail:not(.hidden)").waitFor({ timeout: 5000 });
    assert.equal(await page.locator(".agent-card.active").getAttribute("data-agent"), "cartographer",
      "a node deep link switches to the Cartographer tab");
    assert.match(await page.locator("#graph-detail-body").innerText(), /Node 1/,
      "the deep-linked node is resolved and shown in the detail panel");
    assert.equal(await page.locator("#graph-breadcrumbs:not(.hidden) .graph-breadcrumb-chip").count(), 1,
      "a deep-link restore seeds the breadcrumb trail too, not just the detail panel");

    // Graph maximize: a true edge-to-edge fixed-position overlay (not just
    // the panel-width expand toggle), with its own visible "Close ×" button
    // (not just Escape/backdrop -- a first pass had neither, just two
    // stacked icon buttons with no obvious way to exit). The two toggle
    // buttons must not overlap either (regression: they briefly shared the
    // same top-right corner and the maximize one was unclickable).
    await page.locator("#graph-maximize-toggle").click({ timeout: 5000 });
    await page.waitForFunction(() => document.getElementById("graph-panel").classList.contains("maximized"), { timeout: 5000 });
    const maxBox = await page.locator("#graph-panel").boundingBox();
    const viewport = page.viewportSize();
    assert.ok(maxBox.width >= viewport.width && maxBox.height >= viewport.height,
      "maximized graph panel must fill the whole viewport edge-to-edge, not float with margins");
    assert.equal(await page.locator("#graph-maximize-close:not(.hidden)").count(), 1,
      "a visible Close button must appear while maximized");
    assert.equal(await page.evaluate(() => document.body.style.overflow), "hidden",
      "background scroll must be locked while the overlay covers the whole viewport");
    await page.locator("#graph-maximize-close").click();
    await page.waitForFunction(() => !document.getElementById("graph-panel").classList.contains("maximized"), { timeout: 3000 });
    assert.equal(await page.evaluate(() => document.body.style.overflow), "", "closing restores background scroll");

    // Escape must close it too.
    await page.locator("#graph-maximize-toggle").click();
    await page.waitForFunction(() => document.getElementById("graph-panel").classList.contains("maximized"), { timeout: 5000 });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("graph-panel").classList.contains("maximized"), { timeout: 3000 });

    // In-app editor is no longer exposed via a UI button (the "Open in editor"
    // entry points were removed), but the editor code still works and must
    // render a pre-loaded diagram with its own scoped SVG defs. Drive it
    // programmatically to keep that coverage.
    await page.evaluate(() => openEditor());
    await page.waitForFunction(() => document.getElementById("design-view").classList.contains("visible"));
    await page.waitForFunction(() => document.querySelectorAll("#editor-canvas .bshape").length >= 2, { timeout: 5000 });
    assert.equal(await page.locator("#editor-empty").isVisible(), false, "editor must not show its empty state once a diagram is loaded");
    await page.evaluate(() => setMode("chat"));

    // Unsupported-call-SDK fallback: window.Daily absent entirely (CDN truly
    // unreachable, not just the mock) -- needs a fresh navigation since
    // app.js only checks window.Daily at click time, but this simulates a
    // page where even the mock init script's Daily never got defined.
    const page2 = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page2.on("pageerror", error => errors.push(error.message));
    await page2.route("**/daily-js@*/dist/daily.js", route => route.abort());
    await page2.goto("http://127.0.0.1:" + server.address().port);
    await page2.locator('.nav-item[data-view="assistants"]').click();
    await page2.locator("#chat-view.visible .welcome").waitFor();
    await page2.locator("#start-call").click();
    await page2.locator("#call-status.error").waitFor();
    assert.match(await page2.locator("#call-status").innerText(), /Video calling could not load/);
    assert.equal(await page2.locator("#voice-modal").getAttribute("open"), null, "modal must not open without the call SDK");
    await page2.close();

    // --- Login screen: five named profiles, gated behind a session cookie ---
    const VIDAL = { username: "vidal", password: "secret123",
      name: "Maria-Esther Vidal", role: "Professor", avatar: "/images/people/Maria-Esther_Vidal.png" };
    let authProjects = []; // in-memory stand-in for app/projects_store.py's Modal Dict
    const authServer = http.createServer((req, res) => {
      const pathname = new URL(req.url, "http://localhost").pathname;
      const cookie = (req.headers.cookie || "").includes("boxology_session=valid-vidal-session");
      if (pathname === "/api/auth/me") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ auth_enabled: true, user: cookie ? VIDAL : null }));
        return;
      }
      if (pathname === "/api/projects" && req.method === "GET") {
        if (!cookie) { res.writeHead(401).end(); return; }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ projects: authProjects }));
        return;
      }
      if (pathname === "/api/projects" && req.method === "POST") {
        if (!cookie) { res.writeHead(401).end(); return; }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const record = JSON.parse(body || "{}");
          record.id = record.id || "srv-" + Date.now();
          record.updatedAt = new Date().toISOString();
          record.createdAt = record.createdAt || record.updatedAt;
          authProjects = authProjects.filter((p) => p.id !== record.id);
          authProjects.unshift(record);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ project: record }));
        });
        return;
      }
      const projDeleteMatch = pathname.match(/^\/api\/projects\/(.+)$/);
      if (projDeleteMatch && req.method === "DELETE") {
        if (!cookie) { res.writeHead(401).end(); return; }
        authProjects = authProjects.filter((p) => p.id !== decodeURIComponent(projDeleteMatch[1]));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (pathname === "/api/auth/login" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const { username, password } = JSON.parse(body || "{}");
          res.setHeader("Content-Type", "application/json");
          if (username === VIDAL.username && password === VIDAL.password) {
            res.setHeader("Set-Cookie", "boxology_session=valid-vidal-session; Path=/; HttpOnly");
            res.end(JSON.stringify({ ok: true, user: VIDAL }));
          } else {
            res.writeHead(401);
            res.end(JSON.stringify({ error: "Invalid username or password" }));
          }
        });
        return;
      }
      if (pathname === "/api/auth/logout" && req.method === "POST") {
        res.setHeader("Set-Cookie", "boxology_session=; Path=/; Max-Age=0");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      serveStaticFile(pathname, res);
    });
    await new Promise((resolve) => authServer.listen(0, "127.0.0.1", resolve));
    try {
      const authPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const authErrors = [];
      authPage.on("pageerror", (error) => authErrors.push(error.message));
      await authPage.goto("http://127.0.0.1:" + authServer.address().port);

      await authPage.locator("#login-screen:not([hidden])").waitFor({ timeout: 5000 });
      // The dashboard underneath is still in the DOM (CSS overlay, not a DOM
      // swap -- real enforcement is server-side via require_auth on the API
      // routes), so check reachability the way a pointer actually would.
      assert.equal(
        await authPage.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest("#login-screen") != null),
        true, "the dashboard underneath must not be reachable by a click before signing in",
      );
      assert.equal(await authPage.locator(".login-profile").count(), 5, "five profile cards");
      assert.equal(await authPage.locator("#login-form").isVisible(), false, "password field hidden until a profile is chosen");

      // Welcome page: assets, responsive layout, and keyboard isolation.
      const welcomeDir = path.resolve(__dirname, "../../output/welcome-preview");
      fs.mkdirSync(welcomeDir, { recursive: true });
      await authPage.locator("#studio-story").scrollIntoViewIfNeeded();
      await authPage.waitForFunction(() => [...document.querySelectorAll("#login-screen img")].every((img) => img.complete && img.naturalWidth > 0));
      await authPage.screenshot({ path: path.join(welcomeDir, "studio-overview.png") });
      for (const width of [375, 768, 1024, 1440]) {
        await authPage.setViewportSize({ width, height: 1000 });
        await authPage.evaluate(() => document.getElementById("login-screen").scrollTo({ top: 0, behavior: "instant" }));
        assert.equal(await authPage.locator("#login-screen").evaluate((el) => el.scrollWidth <= el.clientWidth), true, `welcome page fits ${width}px`);
        await authPage.screenshot({ path: path.join(welcomeDir, `welcome-${width}.png`) });
      }
      assert.equal(await authPage.locator(".workspace").evaluate((el) => el.inert), true, "workspace is inaccessible before login");
      await authPage.locator('.login-profile[data-username="vidal"]').focus();
      await authPage.keyboard.press("Enter");
      assert.equal(await authPage.locator('.login-profile[data-username="vidal"]').getAttribute("aria-pressed"), "true");
      assert.equal(await authPage.locator("#login-password").evaluate((el) => el === document.activeElement), true, "selection focuses password");
      await authPage.locator("#login-toggle-password").click();
      assert.equal(await authPage.locator("#login-password").getAttribute("type"), "text");
      await authPage.locator("#login-toggle-password").click();
      assert.equal(await authPage.locator("#login-password").getAttribute("type"), "password");

      await authPage.locator('.login-profile[data-username="vidal"]').click();
      await authPage.locator("#login-form").waitFor({ state: "visible" });

      // Wrong password: stays on the login screen with a visible error.
      await authPage.locator("#login-password").fill("not-the-password");
      await authPage.locator("#login-submit").click();
      await authPage.locator("#login-error:not(.hidden)").waitFor({ timeout: 5000 });
      assert.equal(await authPage.locator("#login-screen").isHidden(), false, "wrong password must not sign in");

      // Correct password: in, and the sidebar shows that real person, not a placeholder.
      await authPage.locator("#login-password").fill(VIDAL.password);
      await authPage.locator("#login-submit").click();
      await authPage.locator("#login-screen").waitFor({ state: "hidden", timeout: 5000 });
      await authPage.locator("#view-overview.visible").waitFor({ timeout: 5000 });
      assert.equal(await authPage.locator("#profile-name").innerText(), VIDAL.name);
      assert.equal(await authPage.locator("#profile-role").innerText(), VIDAL.role);
      assert.match(await authPage.locator("#profile-avatar").getAttribute("src"), /Maria-Esther_Vidal/);
      assert.equal(await authPage.locator("#profile-avatar").isVisible(), true, "real photo shown, not the placeholder initial");

      // --- My projects: server-backed dashboard while signed in -------------
      // Faking a short Scholar exchange directly (no /api/chat mock on this
      // auth-focused server) is enough to give saveCurrentProject() a
      // non-empty history to save.
      await authPage.locator('.nav-item[data-view="assistants"]').click();
      await authPage.evaluate(() => {
        history.push({ role: "user", content: "What is clinical decision support?" });
        history.push({ role: "assistant", content: "A system that assists clinicians." });
      });
      await authPage.locator("#save-project").click();
      await authPage.locator("#app-toast.show", { hasText: "saved to your dashboard" }).waitFor({ timeout: 5000 });
      assert.equal(authProjects.length, 1, "save-project POSTs to /api/projects when signed in");
      assert.equal(authProjects[0].agent, "scholar");

      await authPage.locator('.nav-item[data-view="projects"]').click();
      await authPage.locator(".project-row").first().waitFor({ timeout: 5000 });
      assert.equal(await authPage.locator(".project-row").count(), 1, "the saved project lists on the My projects page");

      // Opening it restores the transcript from the server-backed record.
      await authPage.locator(".project-row .secondary-button", { hasText: "Continue" }).click();
      await authPage.locator("#chat-view.visible").waitFor({ timeout: 5000 });
      assert.match(await authPage.locator("#messages").innerText(), /clinical decision support/);

      // Deleting removes it both from the page and from the server record.
      await authPage.locator('.nav-item[data-view="projects"]').click();
      await authPage.locator(".project-delete").click();
      await authPage.waitForFunction(() => document.querySelectorAll(".project-row").length === 0, { timeout: 5000 });
      assert.equal(authProjects.length, 0, "delete calls DELETE /api/projects/:id when signed in");

      // Logout drops the session; a reload lands back on the login screen.
      await authPage.locator("#profile-logout").click();
      await authPage.waitForFunction(() => location.href); // settle after reload triggered by the click handler
      await authPage.locator("#login-screen:not([hidden])").waitFor({ timeout: 5000 });

      assert.deepEqual(authErrors, [], "no console/page errors on the login screen: " + JSON.stringify(authErrors));
      await authPage.close();
    } finally {
      authServer.close();
    }

    // --- A flat, literal-only result (e.g. SELECT DISTINCT ?label) must not
    // scatter dozens of disconnected dots across the graph -- there's no
    // entity identity to draw a relationship between two bare strings, and
    // the Query results table already lists them correctly either way.
    await page.locator('[data-agent="cartographer"]').click();
    const literalRows = Array.from({ length: 20 }, (_, i) => ({ patternLabel: { type: "literal", value: `Pattern ${i}` } }));
    await page.evaluate((rows) => ingestSparqlResult(["patternLabel"], rows), literalRows);
    assert.equal(await page.evaluate(() => graphNodes.length), 0,
      "a flat literal-only result must not be drawn as disconnected graph nodes");
    assert.match(await page.locator("#graph-walk-status").innerText(), /20 distinct value/);

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Mobile must not overflow");
    const mobile = path.join(os.tmpdir(), "boxology-light-mobile.png");
    await page.screenshot({ path: mobile, fullPage: true });

    assert.deepEqual(errors, [], "no console/page errors: " + JSON.stringify(errors));
    console.log(JSON.stringify({ passed: true, desktop: screenshot, mobile }));
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
