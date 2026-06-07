// popup.js — Start/Pause control + live status.
const $ = (id) => document.getElementById(id);
let enabled = false;

async function refresh() {
  let s;
  try {
    s = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  } catch {
    return;
  }
  if (!s || !s.config) return;
  enabled = !!s.config.enabled;

  $("dot").classList.toggle("on", enabled);
  $("statusText").textContent = enabled ? "Running" : "Paused";
  $("dry").textContent = s.config.dryRun ? " · dry-run" : "";
  const t = $("toggle");
  t.textContent = enabled ? "Pause" : "Start";
  t.classList.toggle("paused", enabled);

  $("queue").textContent = s.queue ?? 0;
  $("bids").textContent = s.bidsThisHour ?? 0;
  $("processed").textContent = s.processedCount ?? 0;
  $("scammers").textContent = s.scammerCount ?? 0;

  const ul = $("scamList");
  if (s.scammerList && s.scammerList.length) {
    ul.innerHTML = s.scammerList
      .map((x) => `<li title="${(x.reasons || []).join(' | ').replace(/"/g, "'")}">${x.clientName || x.slug}</li>`)
      .join("");
  }

  const warn = [];
  if (!s.config.apiKey) warn.push("Set your Anthropic API key in Settings.");
  if (!s.config.searchUrl) warn.push("Set your job search URL in Settings.");
  $("warn").textContent = warn.join(" ");
}

$("toggle").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "SET_ENABLED", enabled: !enabled });
  refresh();
};
$("openOptions").onclick = () => chrome.runtime.openOptionsPage();

refresh();
setInterval(refresh, 2000);
