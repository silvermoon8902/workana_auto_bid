// inbox.js — runs on /inbox/<slug>/<user>, the conversation Workana opens right
// after a bid is submitted. Posts project screenshots (by PASTING images, which
// is how Workana uploads them) followed by a short nudge message — but ONLY for
// the bid that was just submitted.

(function () {
  const D = window.WKDom;
  const { qa, waitForSelector, setReactValue, humanDelay, sanitizeOutgoing, send, contextValid, S } = D;

  const m = location.pathname.match(/\/inbox\/([^/?#]+)/i);
  const slug = m ? m[1] : null;
  if (!slug) return;

  function dataUrlToFile(dataUrl, filename) {
    const [meta, b64] = dataUrl.split(",");
    const mime = (meta.match(/data:(.*?);/) || [, "image/png"])[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], filename, { type: mime });
  }

  // Paste an image into the compose box — Workana intercepts the paste and uploads it.
  function pasteImage(target, file) {
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      target.focus();
      let evt;
      try {
        evt = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
      } catch {
        evt = new Event("paste", { bubbles: true, cancelable: true });
      }
      if (!evt.clipboardData) {
        try {
          Object.defineProperty(evt, "clipboardData", { value: dt });
        } catch {}
      }
      target.dispatchEvent(evt);
      return true;
    } catch {
      return false;
    }
  }

  function clickSend() {
    const btn = qa(S.sendButton).find((b) => b.offsetParent !== null) || document.querySelector(S.sendButton);
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }

  function typeInto(box, text) {
    if (box.isContentEditable) {
      box.focus();
      box.textContent = text;
      box.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      setReactValue(box, text);
    }
  }

  async function run() {
    if (!contextValid()) return;
    await humanDelay(1200, 2200); // let the thread render

    const resp = await send({ type: "GET_FOLLOWUP", slug });
    if (!resp || !resp.message) return; // not the just-bid thread, or nothing to send

    let box = await waitForSelector(S.replyBox, { timeout: 6000 });
    if (!box) {
      await send({ type: "FOLLOWUP_DONE", slug, sent: false });
      return;
    }

    // 1) Capture + PASTE the project screenshots, then send them as an image message.
    let pasted = 0;
    if (!resp.dryRun && resp.attachments && resp.attachments.length) {
      const cap = await send({ type: "CAPTURE", urls: resp.attachments, limit: resp.attachments.length });
      const shots = (cap && cap.shots) || [];
      for (const shot of shots) {
        try {
          const file = dataUrlToFile(shot.dataUrl, shot.filename || "project.png");
          if (pasteImage(box, file)) pasted++;
          await humanDelay(1600, 2600); // let the upload register
        } catch {}
      }
      if (pasted) {
        await humanDelay(900, 1500);
        clickSend(); // send the pasted images
        await humanDelay(2500, 4000);
      }
    }

    // 2) Send the nudge text so the client checks the images.
    box = (await waitForSelector(S.replyBox, { timeout: 4000 })) || box;
    const safe = sanitizeOutgoing(resp.message);
    typeInto(box, safe);
    await humanDelay(800, 1400);

    let sent = false;
    if (resp.dryRun) {
      console.log("[WK inbox] DRY RUN — follow-up drafted (not sent):", safe);
    } else {
      sent = clickSend();
    }
    await send({ type: "FOLLOWUP_DONE", slug, sent: sent || pasted > 0, title: document.title });
  }

  run();
})();
