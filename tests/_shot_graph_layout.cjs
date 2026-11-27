const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../app/static");
const scratch = "C:/Users/TEHRAN~1.001/AppData/Local/Temp/claude/u--Eigene-Dateien-BoxologyDoc-T4B-LLM/4243677d-b393-4c89-b646-47ec8d0020f5/scratchpad";

const realData = JSON.parse(fs.readFileSync(path.join(scratch, "real_query_result.json"), "utf8"));

function serveStaticFile(pathname, res) {
  const named = { "/": "index.html", "/app.js": "app.js", "/editor.js": "editor.js", "/desk.js": "desk.js", "/style.css": "style.css", "/save_output.js": "save_output.js" }[pathname];
  const file = named || (pathname.startsWith("/images/") ? pathname.slice(1) : null);
  if (!file || !fs.existsSync(path.join(root, file))) { res.writeHead(404).end(); return; }
  const type = file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
  res.setHeader("Content-Type", type);
  res.end(fs.readFileSync(path.join(root, file)));
}

(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/api/auth/me") { res.end(JSON.stringify({ user: null, auth_enabled: false })); return; }
    serveStaticFile(pathname, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.locator('.nav-item[data-view="assistants"]').click();
  await page.locator('[data-agent="cartographer"]').click();
  await page.waitForFunction(() => !!window.ForceGraph, { timeout: 10000 });

  await page.evaluate((d) => ingestSparqlResult(d.vars, d.rows), realData);
  // Let the physics simulation fully settle (cooldownTicks).
  await page.waitForTimeout(3000);
  await page.evaluate(() => fg.zoomToFit(0, 40)); // instant, no animation-timing uncertainty
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(scratch, process.argv[2] || "layout_current.png"), fullPage: true });
  console.log("node count:", await page.evaluate(() => graphNodes.length));
  console.log("link count:", await page.evaluate(() => graphLinks.length));
  console.log("sample positions:", await page.evaluate(() =>
    graphNodes.slice(0, 6).map((n) => ({ id: n.id.slice(-12), x: Math.round(n.x), y: Math.round(n.y) }))));
  console.log("full Y range:", await page.evaluate(() => {
    const ys = graphNodes.map((n) => n.y);
    return { min: Math.min(...ys), max: Math.max(...ys), count: ys.length };
  }));
  console.log("full X range:", await page.evaluate(() => {
    const xs = graphNodes.map((n) => n.x);
    return { min: Math.min(...xs), max: Math.max(...xs) };
  }));
  console.log("canvas present:", await page.evaluate(() => !!document.querySelector("#graph-canvas canvas")));
  console.log("canvas size:", await page.evaluate(() => {
    const c = document.querySelector("#graph-canvas canvas");
    return c ? { w: c.width, h: c.height, cssW: c.style.width, cssH: c.style.height } : null;
  }));
  console.log("fg zoom:", await page.evaluate(() => (typeof fg !== "undefined" && fg) ? fg.zoom() : "no fg"));

  await browser.close();
  server.close();
})();
