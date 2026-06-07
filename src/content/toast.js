// toast.js — lightweight in-page toasts, shown on whatever Workana tab is open
// (primarily the persistent search tab). Driven by the background worker so an
// outcome is visible even after the job tab that produced it has closed.

(function () {
  if (window.__wkToastInit) return;
  window.__wkToastInit = true;

  const WRAP_ID = "wk-toast-wrap";
  const COLORS = { success: "#16a34a", info: "#6d28d9", warn: "#b45309", error: "#dc2626" };

  function ensureWrap() {
    let w = document.getElementById(WRAP_ID);
    if (!w) {
      w = document.createElement("div");
      w.id = WRAP_ID;
      Object.assign(w.style, {
        position: "fixed",
        top: "16px",
        right: "16px",
        zIndex: "2147483647",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        maxWidth: "360px",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        pointerEvents: "none",
      });
      (document.body || document.documentElement).appendChild(w);
    }
    return w;
  }

  function show(level, text) {
    const w = ensureWrap();
    const el = document.createElement("div");
    Object.assign(el.style, {
      background: "#fff",
      color: "#1f2937",
      borderLeft: `4px solid ${COLORS[level] || COLORS.info}`,
      boxShadow: "0 6px 20px rgba(0,0,0,.15)",
      borderRadius: "8px",
      padding: "10px 12px",
      fontSize: "13px",
      lineHeight: "1.35",
      opacity: "0",
      transform: "translateX(20px)",
      transition: "opacity .2s, transform .2s",
      pointerEvents: "auto",
      wordBreak: "break-word",
    });
    el.textContent = text;
    w.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = "1";
      el.style.transform = "none";
    });
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateX(20px)";
      setTimeout(() => el.remove(), 300);
    }, 6500);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "TOAST") show(msg.level, msg.text);
  });
})();
