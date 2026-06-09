// inbox.js — runs on /inbox/<slug>/<user>, the conversation Workana opens right
// after a bid is submitted. Posts project screenshots (by PASTING images, which
// is how Workana uploads them) followed by a short nudge message — but ONLY for
// the bid that was just submitted.

(function () {
  const D = window.WKDom;
  const { textOf, qa, waitForSelector, setReactValue, humanDelay, sleep, sanitizeOutgoing, send, contextValid, S } = D;

  // True while an image is uploading. Workana shows an optimistic message with
  // id "optimistic_upload…", a <small class="sending">, and the text
  // "Wait! we are uploading your file".
  function uploadBusy() {
    if (
      qa("[id*='optimistic_upload'], small.sending, .list-attachments-loading, .control-spinner, .wk2-icon-spinner, .wk2-icon-spin")
        .some((e) => e.offsetParent !== null)
    ) {
      return true;
    }
    return qa("h5 span, h5, small, p").some(
      (e) =>
        e.offsetParent !== null &&
        /uploading your file|we are uploading|subiendo (tu )?archivo|enviando (o )?arquivo|estamos enviando/i.test(textOf(e))
    );
  }

  // Wait for the upload to START (briefly), then wait for it to FINISH.
  async function waitForUploads(timeout = 40000) {
    const s0 = Date.now();
    while (Date.now() - s0 < 4000 && !uploadBusy()) await sleep(300);
    const s1 = Date.now();
    while (Date.now() - s1 < timeout) {
      if (!uploadBusy()) return true;
      await sleep(500);
    }
    return false;
  }

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

    // 1) Fetch the highlighted projects' images and PASTE them, then send as a message.
    let pasted = 0;
    if (!resp.dryRun && resp.images && resp.images.length) {
      const cap = await send({ type: "FETCH_IMAGES", urls: resp.images, limit: resp.images.length });
      const shots = (cap && cap.shots) || [];
      for (const shot of shots) {
        try {
          const file = dataUrlToFile(shot.dataUrl, shot.filename || "project.png");
          if (pasteImage(box, file)) pasted++;
          await humanDelay(1000, 1800);
          await waitForUploads(45000); // wait for THIS image to finish uploading
        } catch {}
      }
      if (pasted) {
        await waitForUploads(45000); // make sure every upload is finished
        await humanDelay(700, 1200);
        clickSend(); // send the images
        await waitForUploads(20000); // wait until the send completes
        await humanDelay(2000, 3500);
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
