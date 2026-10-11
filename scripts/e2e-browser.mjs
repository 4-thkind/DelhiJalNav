/**
 * Browser journey test over the Chrome DevTools Protocol. No npm packages.
 *
 *   python backend/local_server.py          (after: cd app && npm run build)
 *   node scripts/e2e-browser.mjs C:/djn-e2e  (output dir: screenshots + a throwaway Chrome profile)
 *
 * Use an output path WITHOUT spaces: Chrome's CacheStorage fails inside a profile
 * path containing spaces, which silently disables the service worker.
 * Env: CHROME (browser path), DJN_URL (default http://127.0.0.1:8787/),
 *      DEMO_ADMIN_KEY (default local-demo-admin) - the run resets the demo namespace first.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const out = process.argv[2];
if (!out || out.includes(" ")) throw new Error("usage: node scripts/e2e-browser.mjs <output-dir-without-spaces>");
mkdirSync(out, { recursive: true });
const URL_ = process.env.DJN_URL ?? "http://127.0.0.1:8787/";
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

const reset = await fetch(new URL("/v1/demo/control", URL_), {
  method: "POST",
  headers: { "content-type": "application/json", "x-demo-admin-key": process.env.DEMO_ADMIN_KEY ?? "local-demo-admin" },
  body: JSON.stringify({ reset: true }),
});
if (!reset.ok) throw new Error("demo reset failed: HTTP " + reset.status);

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--remote-debugging-port=9333", `--user-data-dir=${out}/cdp-profile-${Date.now()}`,
  "--window-size=504,1400", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
for (let i = 0; i < 40 && !ws; i++) {
  await sleep(250);
  try {
    const targets = await (await fetch("http://127.0.0.1:9333/json")).json();
    const page = targets.find((t) => t.type === "page");
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch {}
}
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
const logs = [];
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") logs.push("EXCEPTION " + JSON.stringify(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") logs.push("console.error " + msg.params.args.map((a) => a.value ?? a.description).join(" "));
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${out}/${name}.png`, Buffer.from(r.result.data, "base64"));
};
const text = (sel) => js(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ""`);
const click = (sel) => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
const waitFor = async (expr, ms = 8000) => {
  for (let t = 0; t < ms; t += 200) { if (await js(expr)) return; await sleep(200); }
  throw new Error("timeout waiting for " + expr);
};

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 900, deviceScaleFactor: 1, mobile: true });
await send("Page.navigate", { url: URL_ });
await waitFor(`document.querySelector("#decision-card .route-name, #decision-card h2")`);
const checks = [];
const ok = (name, cond, detail = "") => { checks.push(`${cond ? "PASS" : "FAIL"} ${name} ${detail}`); };
ok("first run asks how you travel", await js(`!document.querySelector("#screen-welcome").classList.contains("hidden")`));
await js(`document.querySelector('[data-role="rider"]').click()`);
await waitFor(`document.querySelector("#role-label").innerText.includes("Two-wheeler rider")`);
ok("rider role sets two-wheeler", true && await js(`document.querySelector("#screen-welcome").classList.contains("hidden")`));

ok("no horizontal overflow at 360px", await js("document.documentElement.scrollWidth <= innerWidth"), await js("document.documentElement.scrollWidth+'/'+innerWidth"));
ok("baseline suggested with no reports", (await text("#decision-card")).includes("Via Minto Road underpass"));
ok("no-reports message, no 'safe' claim", (await text("#decision-card")).includes("No current waterlogging reports") && !/\bsafe\b(?! guarantee)/i.test((await text("#decision-card")).replace("not a safety guarantee", "")));
ok("mode label visible", (await text("#mode-badge")).includes("Demo"));
await waitFor(`document.body.dataset.map && document.querySelector(document.body.dataset.map === "google" ? "#plan-map .gm-style" : "#plan-map.leaflet-container")`, 15000);
ok("map renders", true, await js("document.body.dataset.map"));

// the rider's own camera flags water inside the basin: personal bypass, nothing reported
await click("#btn-demo-water");
await waitFor(`document.querySelector("#decision-card").innerText.includes("camera flagged") && !document.querySelector("#decision-card .route-name").innerText.includes("Minto")`, 15000);
ok("camera water reroutes to the flyover bypass", (await text("#decision-card .route-name")).length > 0, await text("#decision-card .route-name"));
ok("camera water is not shared evidence", (await text("#decision-card")).includes("No current waterlogging reports"));
await js(`[...document.querySelectorAll("#decision-card button")].find((b) => b.innerText === "Clear").click()`);
await waitFor(`document.querySelector("#decision-card .route-name").innerText.includes("Minto")`, 15000);
ok("clearing the camera flag restores the fastest route", true);

await click("#dock-hide");
await sleep(450);
ok("dock hides, Route button appears", await js(`getComputedStyle(document.querySelector("#sheet")).visibility === "hidden" && getComputedStyle(document.querySelector("#dock-open")).opacity === "1"`));
await click("#dock-open");
await sleep(450);
ok("Route button brings the dock back", await js(`getComputedStyle(document.querySelector("#sheet")).visibility === "visible"`), await text("#dock-eta"));
ok("five vehicle chips visible", await js(`[...document.querySelectorAll("#vehicle-row .vchip")].filter((b) => b.getBoundingClientRect().height >= 40).length === 5`));

// auto-fill from Hinglish text (rules or Bedrock), then the real form
await click("#btn-report");
await js(`document.querySelector("#rep-text").value = "Minto Bridge ke neeche ghutne tak paani bhara hai"`);
await click("#btn-autofill");
await waitFor(`document.querySelector("#rep-draft-info").innerText.includes("Draft by")`);
ok("auto-fill picks water + knee depth", await js(`document.querySelector('input[value="WATER_OBSERVED"]').checked && document.querySelector("#rep-depth").value === "knee"`), await text("#rep-draft-info"));
await js(`document.querySelector("#rep-text").value = ""; document.querySelector("#rep-depth").value = ""`);
await js(`document.querySelector('input[value="WATER_OBSERVED"]').click()`);
await js(`document.querySelector("#rep-text").value = "<b>Underpass</b> mein paani hai"`);
await click("#btn-rep-next");
ok("review step shows understood fields", (await text("#rep-review-body")).includes("Water on the road"));
ok("review renders text as text (no HTML)", await js(`!document.querySelector("#rep-review-body b b") && document.querySelector("#rep-review-body").innerText.includes("<b>Underpass</b>")`));
await click("#btn-rep-submit");
await waitFor(`document.querySelector("#rep-results").innerText.includes("Accepted")`);
ok("report A accepted", (await text("#rep-results")).includes("Reported"), await text("#rep-results"));
await shot("e2e-report");

// contributor B
await js(`document.querySelector("#rep-contributor").value = "demo-b"; document.querySelector("#rep-contributor").dispatchEvent(new Event("change"))`);
await js(`document.querySelector('input[value="WATER_OBSERVED"]').click()`);
await click("#btn-rep-next");
await click("#btn-rep-submit");
await waitFor(`document.querySelector("#rep-results").innerText.includes("Corroborated")`);
ok("report B corroborates", true);

await click("#btn-rep-back");
await waitFor(`document.querySelector("#decision-card").innerText.includes("Shivaji")`);
ok("route switched to detour", (await text("#decision-card")).includes("Detour adds"));
ok("rejected card names reason", (await text("#route-cards")).includes("passes through the affected underpass"));
await shot("e2e-planner-after");

ok("reroute notice shown with accept/keep", (await text("#reroute-notice")).includes("REROUTE NOTICE"));
await js(`document.querySelector("#reroute-notice .primary").click()`);
ok("notice dismissed after accepting bypass", await js(`document.querySelector("#reroute-notice").hidden`));
await click("#btn-nav");
await waitFor(`!document.querySelector("#guidance").hidden && document.querySelector("#g-text").innerText.length > 3`);
ok("simulated drive shows guidance + label", (await text("#sim-label")).toLowerCase().includes("simulated"), await text("#g-text"));
await click("#btn-nav");

await click("#btn-why");
await waitFor(`document.querySelector("#evidence-body").innerText.includes("Source 2")`);
const ev = await text("#evidence-body");
ok("evidence shows sources, policy, limits", ev.includes("flood-policy-v1") && ev.toLowerCase().includes("limits") && ev.includes("Source 1"));
ok("evidence description is text", ev.includes("<b>Underpass</b>"));
await shot("e2e-evidence");
ok("evidence fits 360px", await js(`[...document.querySelectorAll("#evidence-body *")].every((el) => el.getBoundingClientRect().right <= innerWidth + 0.5)`));
await click("#btn-ev-back");

// car layout: no overflow, 54px targets
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 560, deviceScaleFactor: 1, mobile: false });
await sleep(300);
ok("car-size screen picks dark HUD + 54px targets", await js(`getComputedStyle(document.documentElement).getPropertyValue("--target").trim() === "54px" && document.documentElement.scrollWidth <= innerWidth`));
await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 900, deviceScaleFactor: 1, mobile: true });
await sleep(300);

// camera ride on the chosen route (fake camera + fake GPS near the start)
await send("Browser.grantPermissions", { origin: new URL(URL_).origin, permissions: ["geolocation", "videoCapture"] });
await send("Emulation.setGeolocationOverride", { latitude: 28.6419, longitude: 77.2290, accuracy: 10 });
await click("#btn-ride");
await waitFor(`!document.querySelector("#rg-text").innerText.includes("Waiting")`, 15000);
ok("ride: camera on, guidance from GPS, water warning", await js(`document.querySelector("#cam-off").hidden && document.querySelector("#ride-water").innerText.includes("Avoiding")`), await text("#rg-text"));
ok("ride map: rider avatar following GPS, flood spiral on the reported underpass", await js(`!!document.querySelector("#ride-map .rider-avatar:not(.weak)") && document.querySelectorAll("#ride-map .flood-spiral").length >= 1`),
  await js(`(document.querySelector("#ride-map").classList.contains("map-tpp") ? "3D third-person" : "flat follow (no WebGL)") + " · " + document.body.dataset.map`));
await waitFor(`document.querySelector("#hud-model").innerText.includes("potholes only")`, 30000);
ok("ride: pothole detector running on camera", true, await text("#hud-model"));
await waitFor(`/^[1-9]/.test(document.querySelector("#hud-buffer").innerText)`, 15000).catch(() => {});
ok("dashcam: speed-adaptive recorder buffering", /^[1-9]/.test(await text("#hud-buffer")), await text("#hud-buffer"));
await shot("e2e-ride");
await click("#btn-end");
await click("#btn-home");

// pocket mode: camera never opened, black screen, guidance still runs
await click("#mode-pocket");
await click("#btn-ride");
await waitFor(`!document.querySelector("#screen-ride").classList.contains("hidden")`);
await sleep(1500);
ok("pocket mode: camera off, black guidance screen", await js(`document.querySelector("#screen-ride").classList.contains("pocket") && !document.querySelector("#cam").srcObject && getComputedStyle(document.querySelector("#cam")).display === "none" && !document.querySelector("#pocket-note").hidden && getComputedStyle(document.querySelector("#screen-ride")).backgroundColor === "rgb(0, 0, 0)"`), await text("#rg-text"));
await shot("e2e-pocket");
await click("#btn-end");
await click("#btn-home");
await click("#mode-camera");

// optional: water + pothole models on real photos (DJN_FLOOD_PHOTO / DJN_DRY_PHOTO = local image paths)
for (const [env, expectWater] of [["DJN_FLOOD_PHOTO", true], ["DJN_DRY_PHOTO", false]]) {
  if (!process.env[env]) continue;
  await click("#btn-camera");
  const doc = await send("DOM.getDocument");
  const { result } = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#photo-test" });
  await js(`document.querySelector("#photo-result").textContent = ""`);
  await send("DOM.setFileInputFiles", { nodeId: result.nodeId, files: [process.env[env]] });
  await waitFor(`/potholes found/.test(document.querySelector("#photo-result").innerText)`, 60000);
  const verdict = await text("#photo-result");
  ok(`photo test: ${expectWater ? "flooded street reads as water" : "dry road reads as no water"}`, verdict.startsWith(expectWater ? "WATER" : "no water"), verdict);
  await click("#btn-settings-back");
}

// edit start + destination: landmark, search, swap, reset
await click("#od-from");
await waitFor(`document.querySelectorAll("#place-landmarks button").length > 3`);
await js(`[...document.querySelectorAll("#place-landmarks button")].find((b) => b.innerText === "Delhi Gate").click()`);
await waitFor(`document.querySelector("#od-from").innerText === "Delhi Gate"`);
await click("#od-to");
await js(`document.querySelector("#place-q").value = "Janpath"; document.querySelector("#place-form").requestSubmit()`);
await waitFor(`document.querySelectorAll("#place-results li").length > 0`, 15000);
await js(`document.querySelector("#place-results li").click()`);
await waitFor(`document.querySelector("#od-to").innerText.includes("Janpath") && document.querySelector("#decision-card .route-name")`, 20000);
ok("start + destination editable (landmark + search)", (await text("#route-cards")).length > 0, (await text("#od-from")) + " -> " + (await text("#od-to")));
await click("#od-swap");
await waitFor(`document.querySelector("#od-from").innerText.includes("Janpath")`);
ok("swap start and destination", (await text("#od-to")) === "Delhi Gate");
await click("#btn-preset");
await waitFor(`document.querySelector("#od-from").innerText.includes("Ajmeri")`, 15000);
ok("reset to preset route", true);

// weak GPS is rejected, not followed
await send("Emulation.setGeolocationOverride", { latitude: 28.66, longitude: 77.20, accuracy: 900 });
await click("#btn-ride");
await waitFor(`document.querySelector("#hud-gps").innerText.includes("900")`, 15000);
ok("weak GPS fix flagged and ignored", await js(`document.querySelector("#hud-gps").parentElement.classList.contains("hud-weak") && document.querySelector("#rg-text").innerText.includes("Weak GPS")`), await text("#rg-text"));
await click("#btn-end");
await click("#btn-home");

// Hindi toggle
await click("#btn-lang");
ok("hindi strings applied", (await text("#btn-compare")).includes("रास्ते"));
await click("#btn-lang");

// offline reload: cached snapshot labelled, not live
await sleep(3000);
await waitFor("!!navigator.serviceWorker.controller", 40000);
ok("service worker controls page", true);
await send("Network.enable");
await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await send("Page.reload");
await sleep(3000);
const offlineCard = await text("#decision-card");
ok("offline reload shows saved route, labelled", offlineCard.includes("Saved route") && (await text("#mode-badge")).includes("Offline"), (await text("#mode-badge")));
await shot("e2e-offline");

// queue while offline, then reconnect
await click("#btn-report");
await js(`document.querySelector('input[value="NO_WATER_OBSERVED"]').click()`);
await click("#btn-rep-next");
await click("#btn-rep-submit");
await sleep(500);
ok("offline report stays queued", (await text("#queue-count")).includes("1"), await text("#queue-count"));
await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await js(`dispatchEvent(new Event("online"))`);
await waitFor(`document.querySelector("#queue-count").innerText.includes(": 0")`, 15000);
ok("queued report delivered after reconnect", true, await text("#rep-results"));

// cross-client: another client's reports reach this stopped page through polling alone
await click("#btn-rep-back");
const api = (path, body, headers = {}) => fetch(new URL(path, URL_), {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
}).then((r) => r.json());
await api("/v1/demo/control", { reset: true }, { "x-demo-admin-key": process.env.DEMO_ADMIN_KEY ?? "local-demo-admin" });
await click("#btn-compare");
await waitFor(`document.querySelector("#decision-card").innerText.includes("Via Minto Road underpass")`);
const status = await (await fetch(new URL("/v1/status", URL_))).json();
const started = Date.now();
for (const who of ["demo-x", "demo-y"]) {
  await api("/v1/observations", {
    schemaVersion: "1.0", eventId: crypto.randomUUID(), hotspotId: "MINTO_BRIDGE", kind: "WATER_OBSERVED",
    observedAt: status.serverTime, location: { source: "selected_hotspot", accuracyM: null }, clientMode: status.clientMode,
  }, { "x-demo-contributor": who });
}
await waitFor(`document.querySelector("#decision-card").innerText.includes("Shivaji")`, 30000);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
ok("other client's reports reroute this page by polling", true, `${seconds}s`);
ok("update labelled as new report + recalculated", (await text("#update-note")).includes("New report received"), await text("#update-note"));

ok("no page exceptions", logs.length === 0, logs.join(" | "));
console.log(checks.join("\n"));
chrome.kill();
process.exit(checks.some((c) => c.startsWith("FAIL")) ? 1 : 0);
