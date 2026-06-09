// options.js — load/save config + dynamic rows for projects and price tiers.
import { getConfig, setConfig } from "./lib/storage.js";

const $ = (id) => document.getElementById(id);

function projectRow(p = { title: "", summary: "", link: "" }) {
  const div = document.createElement("div");
  div.className = "row";
  div.style.marginBottom = "8px";
  div.innerHTML = `
    <input type="text" class="p-title" placeholder="Title" />
    <input type="text" class="p-summary" placeholder="One-line result/summary" />
    <input type="text" class="p-link" placeholder="https://..." />
    <button class="btn-x" type="button">✕</button>`;
  div.querySelector(".p-title").value = p.title || "";
  div.querySelector(".p-summary").value = p.summary || "";
  div.querySelector(".p-link").value = p.link || "";
  div.querySelector(".btn-x").onclick = () => div.remove();
  return div;
}

function tierRow(t = { min: 0, max: 0, bid: 0 }) {
  const div = document.createElement("div");
  div.className = "grid3";
  div.innerHTML = `
    <input type="number" class="t-min" placeholder="min" />
    <input type="number" class="t-max" placeholder="max" />
    <input type="number" class="t-bid" placeholder="bid" />
    <button class="btn-x" type="button">✕</button>`;
  div.querySelector(".t-min").value = t.min;
  div.querySelector(".t-max").value = t.max;
  div.querySelector(".t-bid").value = t.bid;
  div.querySelector(".btn-x").onclick = () => div.remove();
  return div;
}

async function load() {
  const c = await getConfig();
  $("apiKey").value = c.apiKey;
  $("model").value = c.model;
  $("profile").value = c.profile;
  $("ranking").value = c.ranking;
  $("searchUrl").value = c.searchUrl;
  $("proposalPrompt").value = c.proposalPrompt;
  $("replyRules").value = c.replyRules;
  $("underbidPct").value = c.underbidPct;
  $("pollMinutes").value = c.pollMinutes;
  $("maxBidsPerHour").value = c.maxBidsPerHour;
  $("dryRun").checked = c.dryRun;
  $("followUpQuestion").checked = c.followUpQuestion;
  $("attachScreenshots").checked = c.attachScreenshots;
  $("maxAttachments").value = c.maxAttachments;
  $("focusTabs").checked = c.focusTabs;
  $("sendFollowUp").checked = c.sendFollowUp;
  $("followUpPrompt").value = c.followUpPrompt;

  const proj = $("projects");
  proj.innerHTML = "";
  (c.projects.length ? c.projects : [{}]).forEach((p) => proj.appendChild(projectRow(p)));

  const tiers = $("tiers");
  tiers.innerHTML = "";
  (c.priceStrategy.length ? c.priceStrategy : [{}]).forEach((t) => tiers.appendChild(tierRow(t)));
}

async function save() {
  const projects = Array.from(document.querySelectorAll("#projects .row"))
    .map((r) => ({
      title: r.querySelector(".p-title").value.trim(),
      summary: r.querySelector(".p-summary").value.trim(),
      link: r.querySelector(".p-link").value.trim(),
    }))
    .filter((p) => p.title);

  const priceStrategy = Array.from(document.querySelectorAll("#tiers .grid3"))
    .map((r) => ({
      min: Number(r.querySelector(".t-min").value) || 0,
      max: Number(r.querySelector(".t-max").value) || 0,
      bid: Number(r.querySelector(".t-bid").value) || 0,
    }))
    .filter((t) => t.bid > 0);

  await setConfig({
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim() || "claude-opus-4-8",
    profile: $("profile").value,
    ranking: $("ranking").value.trim(),
    searchUrl: $("searchUrl").value.trim(),
    proposalPrompt: $("proposalPrompt").value,
    replyRules: $("replyRules").value,
    underbidPct: Number($("underbidPct").value) || 15,
    pollMinutes: Number($("pollMinutes").value) || 1,
    maxBidsPerHour: Number($("maxBidsPerHour").value) || 10,
    dryRun: $("dryRun").checked,
    followUpQuestion: $("followUpQuestion").checked,
    attachScreenshots: $("attachScreenshots").checked,
    maxAttachments: Number($("maxAttachments").value) || 0,
    focusTabs: $("focusTabs").checked,
    sendFollowUp: $("sendFollowUp").checked,
    followUpPrompt: $("followUpPrompt").value,
    projects,
    priceStrategy,
  });

  // Let the background reconcile the alarm if the interval changed.
  chrome.runtime.sendMessage({ type: "GET_STATUS" }).catch(() => {});
  const msg = $("savedMsg");
  msg.textContent = "Saved ✓";
  setTimeout(() => (msg.textContent = ""), 2000);
}

$("addProject").onclick = () => $("projects").appendChild(projectRow());
$("addTier").onclick = () => $("tiers").appendChild(tierRow());
$("save").onclick = save;
load();
