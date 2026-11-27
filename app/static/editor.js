// --- In-app diagram editor ---------------------------------------------------
//
// Reuses app.js's existing pure SVG-building helpers (shapeElement, shapeLabel,
// orthogonalPath, renderSvgDefs, svgEl, nodeSize, setDownload) in a
// non-animated render mode. Matches Tool4Boxology's editor interactions on top
// of our own SVG renderer (no GoJS dependency, which requires a commercial
// license): drag a shape from the palette to create a node, shift-drag from a
// node to another to link them, click to select + Delete/Backspace to remove,
// double-click a label to rename it, Ctrl+Z/Ctrl+Y (or the toolbar buttons) to
// undo/redo, and "Re-arrange" to re-run the server-side layered auto-arrange
// layout (BRINK/boxology_layout.py via POST /api/boxology/rearrange) -- the
// same function plan_to_boxology() calls when a diagram is first generated.
// No bundler/modules in this app (see app.js's header comment), so this file
// is a second plain <script> sharing app.js's global scope, loaded right
// after it.
//
// Handoff: editorDiagram is a plain module-level variable, set by app.js
// whenever a "plan" SSE event arrives (or by openEditor() from an explicit
// "Open in editor" click) -- there's no router/reload in this SPA, so a
// plain in-memory variable covers "open pre-loaded" without any serialized
// diagram-document format or server round trip.

let editorDiagram = null;
let editorBoxes = new Map(); // node key -> {x,y,w,h,cx,cy}, kept live across drags
let editorSelection = null; // {type:"node", key} | {type:"link", from, to} | null
let editorHistory = [];
let editorHistoryIndex = -1;
const EDITOR_HISTORY_LIMIT = 50;

// Mirrors BRINK/kg_concepts.py's NODE_STYLE + SHAPE_SIZE tables exactly, so
// shapes created here look identical to ones Boxologist generates.
const PALETTE_TYPES = [
  { name: "Data", shape: "Rectangle", color: "#c4e8ffff", stroke: "#1E5F8B" },
  { name: "Symbol", shape: "Rectangle", color: "#d1f0c9ff", stroke: "#218721ff" },
  { name: "Actor", shape: "Triangle", color: "#ffdcabff", stroke: "#9c6921" },
  { name: "Model", shape: "Hexagon", color: "#edd3f3ff", stroke: "#8B4F8B" },
  { name: "Transform", shape: "RoundedRectangle", color: "#fbf1b0ff", stroke: "#B8A600" },
  { name: "Train", shape: "RoundedRectangle", color: "#ffc2a0", stroke: "#c05f30" },
  { name: "Deduce", shape: "RoundedRectangle", color: "#ffcdcd", stroke: "#4c003bff" },
  { name: "Engineer", shape: "RoundedRectangle", color: "#f6d6cf", stroke: "#b85068" },
];

function openEditor(boxologyFile) {
  if (boxologyFile) editorDiagram = JSON.parse(JSON.stringify(boxologyFile));
  editorSelection = null;
  editorHistory = [];
  editorHistoryIndex = -1;
  setMode("design");
  pushHistory();
}

function renderEditor() {
  const svg = document.getElementById("editor-canvas");
  const empty = document.getElementById("editor-empty");
  svg.innerHTML = "";
  editorBoxes = new Map();

  if (!editorDiagram) {
    empty.classList.remove("hidden");
    document.getElementById("editor-download").removeAttribute("href");
    return;
  }
  empty.classList.add("hidden");
  renderSvgDefs(svg);

  const nodes = editorDiagram.nodeDataArray || [];
  const links = editorDiagram.linkDataArray || [];
  const groups = nodes.filter((n) => n.isGroup);
  const shapes = nodes.filter((n) => !n.isGroup);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of shapes) {
    const [x, y] = (n.loc || "0 0").split(" ").map(Number);
    const [w, h] = nodeSize(n);
    minX = Math.min(minX, x - 60); minY = Math.min(minY, y - 50);
    maxX = Math.max(maxX, x + w + 60); maxY = Math.max(maxY, y + h + 50);
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 400; maxY = 300; }
  svg.setAttribute("viewBox", `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
  svg.appendChild(svgEl("rect", { x: minX, y: minY, width: maxX - minX, height: maxY - minY, fill: "url(#editor-canvas-grid)" }));

  const layer = svgEl("g");
  svg.appendChild(layer);
  const linkLayer = svgEl("g");
  layer.appendChild(linkLayer);

  for (const group of groups) {
    // Bounding box from DIRECT members only (node.group === this cluster).
    // A shared node (isShared, sharedGroups: [...]) has exactly one drawn
    // position -- wherever the cluster that first claimed it during layout
    // put it -- so folding every cluster it's merely *associated with* into
    // this box would stretch it to engulf whichever cluster actually holds
    // that node. Every real cluster always has at least its own process
    // node as a direct (never-shared) member, so this never produces an
    // empty box in practice.
    const members = shapes.filter((n) => n.group === group.key);
    if (!members.length) continue;
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
    groupEl.style.opacity = "1";
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
  }

  for (const node of shapes) {
    const { el, box } = shapeElement(node, "editor-canvas");
    const text = shapeLabel(node, box);
    el.style.opacity = "1";
    text.style.opacity = "1";
    el.style.cursor = "grab";
    el.dataset.key = node.key;
    if (editorSelection?.type === "node" && editorSelection.key === node.key) el.classList.add("selected");
    layer.appendChild(el);
    layer.appendChild(text);
    editorBoxes.set(node.key, box);
    makeDraggable(el, text, node, svg, layer);
    el.addEventListener("dblclick", (event) => { event.stopPropagation(); startLabelEdit(node, svg); });
  }

  layer.appendChild(linkLayer);
  for (const link of links) {
    renderLink(linkLayer, link);
  }

  svg.addEventListener("click", clearSelection);
  refreshEditorDownload();
  updateUndoRedoButtons();
}

function renderLink(linkLayer, link) {
  const from = editorBoxes.get(link.from), to = editorBoxes.get(link.to);
  if (!from || !to) return;
  const d = orthogonalPath(from, to);
  const g = svgEl("g", { class: "blink-group" });
  // Wide invisible path under the thin visible stroke -- the visible link is
  // only ~1.6px wide, far too thin to reliably click for selection.
  const hit = svgEl("path", { class: "blink-hit", d, fill: "none" });
  const path = svgEl("path", { class: "blink", d, "marker-end": "url(#editor-canvas-arrow)" });
  hit.dataset.from = path.dataset.from = link.from;
  hit.dataset.to = path.dataset.to = link.to;
  path.style.opacity = "1";
  if (editorSelection?.type === "link" && editorSelection.from === link.from && editorSelection.to === link.to) {
    path.classList.add("selected");
  }
  g.append(hit, path);
  g.addEventListener("click", (event) => { event.stopPropagation(); selectLink(link.from, link.to); });
  linkLayer.appendChild(g);
}

function refreshEditorDownload() {
  if (!editorDiagram) return;
  const name = (editorDiagram.modelData?.boxologyId || "boxology").replace(/[^a-zA-Z0-9-]/g, "_");
  setDownload(document.getElementById("editor-download"), `${name}.boxology`, JSON.stringify(editorDiagram, null, 2));
}

function moveShapeElement(el, node, box) {
  if (node.shape === "Triangle") {
    el.setAttribute("points", `${box.cx},${box.y} ${box.x + box.w},${box.y + box.h} ${box.x},${box.y + box.h}`);
  } else if (node.shape === "Hexagon") {
    const pts = [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]
      .map(([fx, fy]) => `${box.x + fx * box.w},${box.y + fy * box.h}`).join(" ");
    el.setAttribute("points", pts);
  } else {
    el.setAttribute("x", box.x);
    el.setAttribute("y", box.y);
  }
}

function moveLabelElement(text, box) {
  text.setAttribute("x", box.cx);
  const tspans = Array.from(text.children);
  const lineHeight = 11;
  const startY = box.cy - ((tspans.length - 1) * lineHeight) / 2 + 3;
  tspans.forEach((tspan, i) => {
    tspan.setAttribute("x", box.cx);
    tspan.setAttribute("y", startY + i * lineHeight);
  });
}

function updateLinksTouching(nodeKey, layer) {
  layer.querySelectorAll(`.blink-hit[data-from="${nodeKey}"], .blink-hit[data-to="${nodeKey}"]`).forEach((hit) => {
    const from = editorBoxes.get(hit.dataset.from);
    const to = editorBoxes.get(hit.dataset.to);
    if (!from || !to) return;
    const d = orthogonalPath(from, to);
    hit.setAttribute("d", d);
    const visible = hit.parentElement.querySelector(".blink");
    if (visible) visible.setAttribute("d", d);
  });
}

function clientToViewBox(svg, clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  return {
    x: vb.x + (clientX - rect.left) * (vb.width / rect.width),
    y: vb.y + (clientY - rect.top) * (vb.height / rect.height),
  };
}

function findNodeAtPoint(svg, clientX, clientY) {
  const { x: px, y: py } = clientToViewBox(svg, clientX, clientY);
  for (const [key, box] of editorBoxes) {
    if (px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h) return key;
  }
  return null;
}

function makeDraggable(el, text, node, svg, layer) {
  let mode = null; // "move" | "link"
  let moved = false;
  let start = null;
  let linkPreview = null;

  el.addEventListener("pointerdown", (event) => {
    el.setPointerCapture(event.pointerId);
    moved = false;
    if (event.shiftKey) {
      mode = "link";
      const box = editorBoxes.get(node.key);
      linkPreview = svgEl("path", { class: "blink-preview", d: `M ${box.cx} ${box.cy} L ${box.cx} ${box.cy}`, fill: "none" });
      layer.appendChild(linkPreview);
    } else {
      mode = "move";
      el.style.cursor = "grabbing";
      const [x, y] = (node.loc || "0 0").split(" ").map(Number);
      start = { pointerX: event.clientX, pointerY: event.clientY, nodeX: x, nodeY: y };
    }
    event.stopPropagation();
  });

  el.addEventListener("pointermove", (event) => {
    if (!mode) return;
    moved = true;
    if (mode === "move") {
      const rect = svg.getBoundingClientRect();
      const scale = svg.viewBox.baseVal.width / rect.width;
      const x = start.nodeX + (event.clientX - start.pointerX) * scale;
      const y = start.nodeY + (event.clientY - start.pointerY) * scale;
      node.loc = `${x} ${y}`;
      const [w, h] = nodeSize(node);
      const box = { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
      editorBoxes.set(node.key, box);
      moveShapeElement(el, node, box);
      moveLabelElement(text, box);
      updateLinksTouching(node.key, layer);
    } else if (mode === "link" && linkPreview) {
      const box = editorBoxes.get(node.key);
      const { x: px, y: py } = clientToViewBox(svg, event.clientX, event.clientY);
      linkPreview.setAttribute("d", `M ${box.cx} ${box.cy} L ${px} ${py}`);
    }
  });

  const stop = (event) => {
    if (!mode) return;
    if (mode === "move") {
      el.style.cursor = "grab";
      if (moved) pushHistory();
    } else if (mode === "link") {
      if (linkPreview) linkPreview.remove();
      linkPreview = null;
      const targetKey = findNodeAtPoint(svg, event.clientX, event.clientY);
      if (targetKey && targetKey !== node.key) addLink(node.key, targetKey);
    }
    mode = null;
  };
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", () => {
    if (linkPreview) linkPreview.remove();
    linkPreview = null;
    mode = null;
  });

  el.addEventListener("click", (event) => {
    if (moved) return;
    event.stopPropagation();
    selectNode(node.key);
  });
}

function addLink(fromKey, toKey) {
  if (!editorDiagram) return;
  const exists = editorDiagram.linkDataArray.some((l) => l.from === fromKey && l.to === toKey);
  if (exists) return;
  editorDiagram.linkDataArray.push({ from: fromKey, to: toKey });
  renderEditor();
  pushHistory();
}

function nextNodeKey() {
  const existing = new Set((editorDiagram.nodeDataArray || []).map((n) => n.key));
  let i = (editorDiagram.nodeDataArray || []).length + 1;
  let key = `node${i}`;
  while (existing.has(key)) { i += 1; key = `node${i}`; }
  return key;
}

function addPaletteNode(typeName, viewBoxX, viewBoxY) {
  const def = PALETTE_TYPES.find((t) => t.name === typeName);
  if (!def || !editorDiagram) return;
  const [w, h] = SHAPE_SIZE[def.name] || [135, 60];
  const key = nextNodeKey();
  const node = {
    key, name: def.name, label: def.name, type: def.name,
    shape: def.shape, color: def.color, stroke: def.stroke,
    loc: `${Math.round(viewBoxX - w / 2)} ${Math.round(viewBoxY - h / 2)}`,
    isShared: false, sharedGroups: [],
  };
  if (def.shape === "Hexagon") node.parameter1 = 1;
  if (def.shape === "RoundedRectangle") node.parameter1 = 15;
  editorDiagram.nodeDataArray.push(node);
  renderEditor();
  selectNode(key);
  pushHistory();
}

function initPalette() {
  const palette = document.getElementById("editor-palette");
  if (!palette) return;
  palette.innerHTML = "";
  const hint = document.createElement("p");
  hint.className = "palette-hint";
  hint.textContent = "Drag a shape onto the canvas to add it. Shift-drag from a shape to link it to another. Double-click a shape to rename it. Select + Delete to remove.";
  palette.appendChild(hint);
  for (const def of PALETTE_TYPES) {
    const item = document.createElement("div");
    item.className = "palette-item";
    item.draggable = true;
    item.title = `Drag onto the canvas to add a ${def.name} shape`;
    const swatch = document.createElement("span");
    swatch.className = "palette-swatch";
    swatch.style.background = def.color;
    swatch.style.borderColor = def.stroke;
    if (def.shape === "Triangle") swatch.style.clipPath = "polygon(50% 0, 100% 100%, 0 100%)";
    else if (def.shape === "Hexagon") swatch.style.clipPath = "polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%)";
    else if (def.shape === "RoundedRectangle") swatch.style.borderRadius = "5px";
    const label = document.createElement("span");
    label.textContent = def.name;
    item.append(swatch, label);
    item.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/boxology-type", def.name);
      event.dataTransfer.effectAllowed = "copy";
    });
    palette.appendChild(item);
  }
}

function initCanvasDrop() {
  const svg = document.getElementById("editor-canvas");
  svg.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  svg.addEventListener("drop", (event) => {
    event.preventDefault();
    const typeName = event.dataTransfer.getData("text/boxology-type");
    if (!typeName || !editorDiagram) return;
    const { x, y } = clientToViewBox(svg, event.clientX, event.clientY);
    addPaletteNode(typeName, x, y);
  });
}

function clearSelection() {
  editorSelection = null;
  document.querySelectorAll("#editor-canvas .bshape.selected").forEach((e) => e.classList.remove("selected"));
  document.querySelectorAll("#editor-canvas .blink.selected").forEach((e) => e.classList.remove("selected"));
}

function selectNode(key) {
  clearSelection();
  editorSelection = { type: "node", key };
  const el = document.querySelector(`#editor-canvas .bshape[data-key="${key}"]`);
  if (el) el.classList.add("selected");
}

function selectLink(from, to) {
  clearSelection();
  editorSelection = { type: "link", from, to };
  const el = document.querySelector(`#editor-canvas .blink[data-from="${from}"][data-to="${to}"]`);
  if (el) el.classList.add("selected");
}

function deleteSelection() {
  if (!editorSelection || !editorDiagram) return;
  if (editorSelection.type === "node") {
    const key = editorSelection.key;
    editorDiagram.nodeDataArray = editorDiagram.nodeDataArray.filter((n) => n.key !== key);
    editorDiagram.linkDataArray = editorDiagram.linkDataArray.filter((l) => l.from !== key && l.to !== key);
  } else {
    const { from, to } = editorSelection;
    editorDiagram.linkDataArray = editorDiagram.linkDataArray.filter((l) => !(l.from === from && l.to === to));
  }
  editorSelection = null;
  renderEditor();
  pushHistory();
}

function startLabelEdit(node, svg) {
  document.getElementById("editor-label-input")?.remove();
  const box = editorBoxes.get(node.key);
  if (!box) return;
  const svgRect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  const scaleX = svgRect.width / vb.width;
  const scaleY = svgRect.height / vb.height;
  const input = document.createElement("input");
  input.id = "editor-label-input";
  input.className = "editor-label-input";
  input.value = node.label || node.name || "";
  input.style.left = `${svgRect.left + (box.x - vb.x) * scaleX}px`;
  input.style.top = `${svgRect.top + (box.cy - vb.y) * scaleY - 11}px`;
  input.style.width = `${box.w * scaleX}px`;
  document.body.appendChild(input);
  input.focus();
  input.select();
  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    node.label = input.value.trim() || node.name || "";
    input.remove();
    renderEditor();
    pushHistory();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); commit(); }
    else if (event.key === "Escape") { event.preventDefault(); committed = true; input.remove(); }
  });
  input.addEventListener("blur", commit);
}

function pushHistory() {
  if (!editorDiagram) return;
  editorHistory = editorHistory.slice(0, editorHistoryIndex + 1);
  editorHistory.push(JSON.parse(JSON.stringify(editorDiagram)));
  if (editorHistory.length > EDITOR_HISTORY_LIMIT) editorHistory.shift();
  editorHistoryIndex = editorHistory.length - 1;
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  const undoBtn = document.getElementById("editor-undo");
  const redoBtn = document.getElementById("editor-redo");
  if (undoBtn) undoBtn.disabled = editorHistoryIndex <= 0;
  if (redoBtn) redoBtn.disabled = editorHistoryIndex >= editorHistory.length - 1;
}

function editorUndo() {
  if (editorHistoryIndex <= 0) return;
  editorHistoryIndex -= 1;
  editorDiagram = JSON.parse(JSON.stringify(editorHistory[editorHistoryIndex]));
  editorSelection = null;
  renderEditor();
}

function editorRedo() {
  if (editorHistoryIndex >= editorHistory.length - 1) return;
  editorHistoryIndex += 1;
  editorDiagram = JSON.parse(JSON.stringify(editorHistory[editorHistoryIndex]));
  editorSelection = null;
  renderEditor();
}

async function editorRearrange() {
  if (!editorDiagram) return;
  const btn = document.getElementById("editor-rearrange");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Arranging…";
  try {
    const response = await fetch("/api/boxology/rearrange", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodeDataArray: editorDiagram.nodeDataArray, linkDataArray: editorDiagram.linkDataArray,
      }),
    });
    const result = await response.json();
    if (response.ok && result.loc) {
      for (const node of editorDiagram.nodeDataArray) {
        if (!node.isGroup && result.loc[node.key]) node.loc = result.loc[node.key];
      }
      renderEditor();
      pushHistory();
    }
  } catch (err) {
    // leave the diagram as-is on failure
  }
  btn.disabled = false;
  btn.textContent = original;
}

document.addEventListener("keydown", (event) => {
  if (!document.getElementById("design-view").classList.contains("visible")) return;
  const active = document.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;
  if ((event.key === "Delete" || event.key === "Backspace") && editorSelection) {
    event.preventDefault();
    deleteSelection();
  } else if (event.ctrlKey && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) editorRedo(); else editorUndo();
  } else if (event.ctrlKey && event.key.toLowerCase() === "y") {
    event.preventDefault();
    editorRedo();
  }
});

document.getElementById("editor-back").addEventListener("click", () => setMode("chat"));
document.getElementById("editor-rearrange").addEventListener("click", editorRearrange);
document.getElementById("editor-undo").addEventListener("click", editorUndo);
document.getElementById("editor-redo").addEventListener("click", editorRedo);

initPalette();
initCanvasDrop();
