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

  const ev = $("events");
  if (s.recentEvents && s.recentEvents.length) {
    const colors = { success: "#16a34a", info: "#6d28d9", warn: "#b45309", error: "#dc2626" };
    ev.innerHTML = s.recentEvents
      .slice(0, 20)
      .map((e) => {
        const t = new Date(e.ts).toLocaleTimeString();
        return `<li style="list-style:none;color:${colors[e.level] || "#374151"};margin-bottom:3px"><span style="color:#9ca3af">${t}</span> ${(e.text || "").replace(/</g, "&lt;")}</li>`;
      })
      .join("");
  }

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
$("resetState").onclick = async () => {
  if (!confirm("Reset all state? This clears processed jobs, scammer list, saved proposals and chat history so everything is re-evaluated.")) return;
  await chrome.runtime.sendMessage({ type: "RESET_STATE" });
  refresh();
};

refresh();
setInterval(refresh, 2000);
