// --- Save output: export every agent's results to downloadable files --------
//
// A fourth plain <script> sharing app.js/desk.js's global scope (no bundler --
// see app.js's header comment), loaded last. It only READS what those scripts
// already rendered (the #messages DOM for text chat, the desk transcript +
// windows for a live call) and the live #graph-canvas; it changes none of their
// logic. Two entry points, wired to the two "Save output" buttons, visible for
// every agent in both modes so the same request works identically either way:
//   - #save-output      (text chat / "prompting")  -> collectChatMarkdown()
//   - #save-desk-output (video call / "ai assist")  -> collectDeskMarkdown()
// Format: Markdown for the answer + Scholar's sources + Cartographer's SPARQL
// queries/results; Cartographer additionally saves the knowledge graph as a
// PNG via app.js's downloadGraphPng() (the same rasterizer the graph panel's
// own "PNG ↓" button uses). Boxologist's diagram has its own dedicated
// .boxology/semantic-JSON/PNG downloads in its panel instead (see
// renderBoxologyPlan() in app.js) -- this still saves its conversation text.

(function () {
  function agentLabel() {
    return (typeof AGENT_NAMES !== "undefined" && AGENT_NAMES[currentAgent]) || currentAgent;
  }

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // Momentary feedback on the button itself (no toast system in this app).
  function flashButton(btn, msg) {
    if (!btn) return;
    if (!btn.dataset.origLabel) btn.dataset.origLabel = btn.textContent;
    btn.textContent = msg;
    clearTimeout(btn._flashTimer);
    btn._flashTimer = setTimeout(() => { btn.textContent = btn.dataset.origLabel; }, 1800);
  }

  function header(title) {
    return [`# ${title}`, "", `_Saved ${new Date().toLocaleString()}_`, ""];
  }

  // ---- Text-chat ("prompting") -> Markdown, read from the #messages DOM ------
  function collectChatMarkdown() {
    const name = agentLabel();
    const lines = header(`${name} — session export`);
    let any = false, turn = 0;
    const messages = document.getElementById("messages");
    if (!messages) return null;
    for (const node of messages.children) {
      if (!node.classList || !node.classList.contains("msg")) continue;
      const textEl = node.querySelector(".msg-text");
      // dataset.raw is the raw Markdown the assistant streamed (textContent is
      // the rendered/HTML-stripped version); fall back to textContent for user
      // turns and any node without a raw buffer.
      const text = textEl ? (textEl.dataset.raw || textEl.textContent || "").trim() : "";
      if (node.classList.contains("user")) {
        any = true; turn += 1;
        lines.push(`## Turn ${turn}`, "", `**You:** ${text}`, "");
      } else if (node.classList.contains("assistant")) {
        any = true;
        if (text) lines.push(`**${name}:** ${text}`, "");
        const queries = node.querySelectorAll(".hops.sparql-note");
        if (queries.length) {
          lines.push("**Queries**", "");
          queries.forEach((q) => lines.push("```sparql", q.textContent.trim(), "```", ""));
        }
        const chips = node.querySelectorAll(".sources .source-chip");
        if (chips.length) {
          lines.push("**Sources**", "");
          chips.forEach((c) => {
            const snippet = (c.title || "").replace(/\s+/g, " ").trim();
            lines.push(`- ${c.textContent.trim()}${snippet ? " — " + snippet : ""}`);
          });
          lines.push("");
        }
      }
    }
    return any ? lines.join("\n") : null;
  }

  // ---- Live call ("ai assist") -> Markdown, read from the desk ---------------
  function collectDeskMarkdown() {
    const name = agentLabel();
    const lines = header(`${name} — call session export`);
    let any = false;

    if (typeof transcriptLog !== "undefined" && transcriptLog.length) {
      any = true;
      lines.push("## Transcript", "");
      transcriptLog.forEach((l) => lines.push(`**${l.role}:** ${l.text}`, ""));
    }

    const srcWin = (typeof WM !== "undefined") ? WM.wins.get("sources") : null;
    const items = srcWin ? srcWin.body.querySelectorAll(".source-item") : [];
    if (items.length) {
      any = true;
      lines.push("## Sources", "");
      items.forEach((it) => {
        const title = (it.querySelector("strong")?.textContent || "Untitled").trim();
        const meta = (it.querySelector(".source-item-meta")?.textContent || "").trim();
        const snippet = (it.querySelector("p")?.textContent || "").trim();
        lines.push(`- ${title}${meta ? " (" + meta + ")" : ""}${snippet ? " — " + snippet : ""}`);
      });
      lines.push("");
    }

    // Cartographer's own query results now live in the Query tab's shared
    // table (inside the reparented graph panel) rather than a separate
    // "results" desk window -- gated to Cartographer specifically since that
    // table is a single page-wide element that could otherwise carry over a
    // stale result from an earlier agent's session.
    const table = currentAgent === "cartographer" ? document.getElementById("query-results-table") : null;
    if (table) {
      const heads = [...table.querySelectorAll("thead th")].map((t) => t.textContent.trim());
      const rows = [...table.querySelectorAll("tbody tr")];
      if (heads.length && rows.length) {
        any = true;
        lines.push("## Query results", "");
        lines.push("| " + heads.join(" | ") + " |");
        lines.push("| " + heads.map(() => "---").join(" | ") + " |");
        rows.forEach((tr) => {
          const cells = [...tr.querySelectorAll("td")]
            .map((td) => td.textContent.trim().replace(/\|/g, "\\|"));
          lines.push("| " + cells.join(" | ") + " |");
        });
        lines.push("");
      }
    }

    return any ? lines.join("\n") : null;
  }

  // ---- Wire up ---------------------------------------------------------------
  const chatBtn = document.getElementById("save-output");
  if (chatBtn) {
    chatBtn.addEventListener("click", async () => {
      const md = collectChatMarkdown();
      if (!md) { flashButton(chatBtn, "Nothing to save yet"); return; }
      downloadFile(`${currentAgent}-session.md`, md, "text/markdown;charset=utf-8");
      if (currentAgent === "cartographer") await downloadGraphPng(`${currentAgent}-session`);
      flashButton(chatBtn, "Saved ✓");
    });
  }

  const deskBtn = document.getElementById("save-desk-output");
  if (deskBtn) {
    deskBtn.addEventListener("click", async () => {
      const md = collectDeskMarkdown();
      let saved = false;
      if (md) { downloadFile(`${currentAgent}-call-session.md`, md, "text/markdown;charset=utf-8"); saved = true; }
      if (currentAgent === "cartographer" && await downloadGraphPng(`${currentAgent}-call-session`)) saved = true;
      flashButton(deskBtn, saved ? "Saved ✓" : "Nothing to save yet");
    });
  }
})();
