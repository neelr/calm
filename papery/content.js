// Papery: an on-page "save this to my reading list" button.
//
// This script owns the button UI and the page metadata (URL, title, favicon);
// all network + auth lives in the service worker (papery/papery-bridge.js),
// reached via chrome.runtime messages with `scope: "papery"`. Routing through
// the worker means a page's CSP can't block saves and the access token never
// enters this (page-adjacent) context — the same split the Curius integration
// uses, just without cookies.
(() => {
  "use strict";

  if (window.__calmPaperyLoaded) {
    return;
  }
  window.__calmPaperyLoaded = true;

  const DOCK_ID = "calm-papery-dock";
  // Only paperyEnabled + paperyEndpoint gate the on-page button; the token
  // itself stays in the service worker.
  const STORAGE_DEFAULTS = {
    paperyEnabled: false,
    paperyEndpoint: "",
  };

  const SVG_BOOKMARK = `<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2zm0 15l-5-2.18L7 18V5h10v13z"/></svg>`;
  const SVG_BOOKMARK_FILLED = `<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg>`;
  const SVG_HIGHLIGHTER = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4l8 8Z"/></svg>`;
  const SVG_HEART = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"/></svg>`;
  const SVG_HEART_FILLED = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;

  let config = { enabled: false, endpoint: "" };
  let state = { saved: false, id: null, liked: false, busy: false };
  let dock = null;
  let dockTab = null;
  let btn = null;
  let heartBtn = null;
  let toastEl = null;
  let toastTimer = 0;
  let tuckTimer = 0;

  // --- config ---------------------------------------------------------------

  function readConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_DEFAULTS, (s) => {
        config = {
          enabled: !!s.paperyEnabled,
          endpoint: String(s.paperyEndpoint || "").trim(),
        };
        resolve(config);
      });
    });
  }

  function isConfigured() {
    return !!config.endpoint;
  }

  // --- bridge messaging -----------------------------------------------------

  function sendPapery(type, payload = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { scope: "papery", type, ...payload },
          (res) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: "bridge_unreachable" });
              return;
            }
            resolve(res || { ok: false, error: "no_response" });
          }
        );
      } catch (err) {
        resolve({ ok: false, error: String((err && err.message) || err) });
      }
    });
  }

  // --- page metadata --------------------------------------------------------

  function pageUrl() {
    try {
      const u = new URL(location.href);
      u.hash = "";
      return u.toString();
    } catch {
      return location.href.split("#")[0];
    }
  }

  function pageTitle() {
    return (document.title || "").trim() || pageUrl();
  }

  function pageSite() {
    return location.hostname.replace(/^www\./, "");
  }

  function pageFavicon() {
    const selectors = [
      'link[rel="icon"]',
      'link[rel="shortcut icon"]',
      'link[rel="apple-touch-icon"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.href) {
        return el.href;
      }
    }
    try {
      return new URL("/favicon.ico", location.origin).toString();
    } catch {
      return "";
    }
  }

  // --- ui -------------------------------------------------------------------

  function buildDock() {
    if (dock) {
      return;
    }
    dock = document.createElement("div");
    dock.id = DOCK_ID;

    toastEl = document.createElement("div");
    toastEl.className = "calm-papery-toast";
    toastEl.hidden = true;

    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "calm-papery-btn";
    btn.addEventListener("click", () => {
      void toggleSave();
    });

    heartBtn = document.createElement("button");
    heartBtn.type = "button";
    heartBtn.className = "calm-papery-btn calm-papery-btn--fav";
    heartBtn.addEventListener("click", () => {
      void toggleLike();
    });

    dock.appendChild(toastEl);
    dock.appendChild(heartBtn);
    dock.appendChild(btn);
    document.documentElement.appendChild(dock);

    // Slim pull-tab at the screen edge; the dock itself stays tucked
    // off-screen until the cursor comes near the corner (it's distracting
    // otherwise).
    dockTab = document.createElement("div");
    dockTab.className = "calm-papery-dock-tab";
    dockTab.title = "Papery";
    dockTab.addEventListener("mouseenter", revealDock);
    document.documentElement.appendChild(dockTab);
    tuckDock();

    render();
  }

  function revealDock() {
    if (!dock) return;
    window.clearTimeout(tuckTimer);
    tuckTimer = 0;
    dock.classList.remove("calm-papery-dock--tucked");
    if (dockTab) dockTab.classList.add("calm-papery-dock-tab--hidden");
  }

  function tuckDock() {
    if (!dock) return;
    window.clearTimeout(tuckTimer);
    tuckTimer = 0;
    dock.classList.add("calm-papery-dock--tucked");
    if (dockTab) dockTab.classList.remove("calm-papery-dock-tab--hidden");
  }

  function scheduleTuck(delay = 350) {
    if (!dock || tuckTimer) return;
    tuckTimer = window.setTimeout(tuckDock, delay);
  }

  // Proximity reveal: cursor near the bottom-right corner slides the dock in.
  document.addEventListener("mousemove", (e) => {
    if (!dock) return;
    const nearX = window.innerWidth - e.clientX < 110;
    const nearY = window.innerHeight - e.clientY < 250;
    if (nearX && nearY) {
      revealDock();
    } else if (!dock.classList.contains("calm-papery-dock--tucked")) {
      scheduleTuck();
    }
  });

  function removeDock() {
    if (dock && dock.parentNode) {
      dock.parentNode.removeChild(dock);
    }
    if (dockTab && dockTab.parentNode) {
      dockTab.parentNode.removeChild(dockTab);
    }
    window.clearTimeout(tuckTimer);
    tuckTimer = 0;
    dock = null;
    dockTab = null;
    btn = null;
    heartBtn = null;
    toastEl = null;
    cycleBtn = null;
    cycleIdx = -1;
  }

  function render() {
    if (!btn) {
      return;
    }
    btn.disabled = state.busy;
    btn.classList.toggle("calm-papery-btn--saved", state.saved);
    btn.innerHTML = state.saved ? SVG_BOOKMARK_FILLED : SVG_BOOKMARK;
    const label = state.saved ? "Remove from Papery" : "Save to Papery";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.setAttribute("aria-pressed", state.saved ? "true" : "false");
    if (heartBtn) {
      // Liking only applies to papered pages — hide the heart otherwise.
      heartBtn.hidden = !state.saved;
      heartBtn.disabled = state.busy;
      heartBtn.classList.toggle("calm-papery-btn--fav-on", state.liked);
      heartBtn.innerHTML = state.liked ? SVG_HEART_FILLED : SVG_HEART;
      const hLabel = state.liked ? "Unlike" : "Mark as a good one";
      heartBtn.title = hLabel;
      heartBtn.setAttribute("aria-label", hLabel);
      heartBtn.setAttribute("aria-pressed", state.liked ? "true" : "false");
    }
  }

  function toast(message) {
    if (!toastEl) {
      return;
    }
    revealDock(); // the dock may be tucked — confirmations must be visible
    toastEl.textContent = message;
    toastEl.hidden = false;
    // Force reflow so the transition runs when re-showing.
    void toastEl.offsetWidth;
    toastEl.classList.add("calm-papery-toast--show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastEl.classList.remove("calm-papery-toast--show");
      window.setTimeout(() => {
        if (toastEl && !toastEl.classList.contains("calm-papery-toast--show")) {
          toastEl.hidden = true;
        }
        scheduleTuck(600);
      }, 200);
    }, 1800);
  }

  function describeError(error) {
    switch (error) {
      case "unauthorized":
        return "Papery: token was rejected";
      case "unconfigured":
        return "Add your Papery token in the extension popup";
      case "disabled":
        return "Papery is turned off";
      case "unreachable":
      case "bridge_unreachable":
      case "no_response":
        return "Papery: could not reach server";
      default:
        if (typeof error === "string" && error.startsWith("http_")) {
          return `Papery: request failed (${error.slice(5)})`;
        }
        return "Papery: request failed";
    }
  }

  // --- actions --------------------------------------------------------------

  async function toggleSave() {
    if (state.busy) {
      return { ok: false, error: "busy" };
    }
    if (!isConfigured()) {
      toast(describeError("unconfigured"));
      return { ok: false, error: "unconfigured" };
    }
    state.busy = true;
    render();
    try {
      let res;
      if (state.saved && state.id != null) {
        res = await sendPapery("unsave", { id: state.id });
        if (res.ok) {
          state.saved = false;
          state.id = null;
          state.liked = false;
          toast("Removed from Papery");
        }
      } else {
        res = await sendPapery("save", {
          url: pageUrl(),
          title: pageTitle(),
          site: pageSite(),
          favicon: pageFavicon(),
        });
        if (res.ok) {
          state.saved = true;
          state.id = res.id != null ? res.id : null;
          toast("Saved to Papery");
        }
      }
      if (!res.ok) {
        toast(describeError(res.error));
      }
      return res;
    } finally {
      state.busy = false;
      render();
    }
  }

  async function refreshState() {
    if (!isConfigured()) {
      return { ok: false, error: "unconfigured" };
    }
    const res = await sendPapery("status", { url: pageUrl() });
    if (res.ok) {
      state.saved = !!res.saved;
      state.id = res.id != null ? res.id : null;
      state.liked = !!res.liked;
      render();
    }
    return res;
  }

  /** Heart the page. Only reachable when it's already papered — the button
   *  is hidden otherwise. */
  async function toggleLike() {
    if (state.busy) {
      return;
    }
    if (!isConfigured()) {
      toast(describeError("unconfigured"));
      return;
    }
    state.busy = true;
    render();
    try {
      if (!state.saved || state.id == null) {
        toast("Save the page first");
        return;
      }
      const res = await sendPapery("toggleLike", { id: state.id });
      if (res.ok) {
        state.liked = !!res.liked;
        toast(state.liked ? "Marked as a good one" : "Unliked");
      } else {
        toast(describeError(res.error));
      }
    } finally {
      state.busy = false;
      render();
    }
  }

  // --- highlights -------------------------------------------------------------
  // Anchoring mirrors the Curius scheme (see curius/content.js): flatten the
  // page's text nodes, map the selection to global offsets, then grow left and
  // right context outward until context+text+context occurs exactly once in
  // the page (with >=15 chars of padding each side). Restore tries the exact
  // concat first, then context-disambiguated occurrences, then first match.

  const HL_TOOLBAR_ID = "calm-papery-hl-toolbar";
  const HL_MIN_PAD = 15;
  let hlToolbar = null;
  let hlToolbarMode = null; // 'add' | {id} for remove
  let pendingRange = null;
  const hlComments = {}; // highlight id -> note text
  // Our controls hide themselves on mousedown, so the matching mouseup
  // retargets to whatever is under the cursor and closest()-guards miss it.
  // Mark the mouseup as ours and swallow it.
  let suppressNextMouseUp = false;

  function normText(s) {
    return String(s || "").replace(/(\r\n|\r)/g, "\n");
  }

  function acceptTextNode(node) {
    if (!node.nodeValue || !node.parentElement) {
      return false;
    }
    if (
      node.parentElement.closest(
        `#${DOCK_ID}, #${HL_TOOLBAR_ID}, script, style, noscript`
      )
    ) {
      return false;
    }
    return true;
  }

  function buildFlatTextMap() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          return acceptTextNode(node)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      }
    );
    const segments = [];
    const parts = [];
    let pos = 0;
    let node;
    while ((node = walker.nextNode())) {
      const val = node.nodeValue;
      if (!val) continue;
      segments.push({ node, start: pos, end: pos + val.length });
      parts.push(val);
      pos += val.length;
    }
    return { text: parts.join(""), segments };
  }

  function textNodeOffset(flat, container, offset) {
    if (container.nodeType === Node.TEXT_NODE) {
      const seg = flat.segments.find((s) => s.node === container);
      if (!seg) return null;
      return seg.start + Math.min(Math.max(0, offset), container.nodeValue.length);
    }
    if (container.nodeType === Node.ELEMENT_NODE) {
      // Boundary sits between element children — use the nearest text node.
      const walkFrom = (el, fromEnd) => {
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
          acceptNode(n) {
            return acceptTextNode(n)
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT;
          },
        });
        let n, last = null;
        while ((n = w.nextNode())) {
          if (!fromEnd) return n;
          last = n;
        }
        return last;
      };
      if (offset < container.childNodes.length) {
        const tn = walkFrom(container.childNodes[offset], false);
        if (tn) {
          const seg = flat.segments.find((s) => s.node === tn);
          if (seg) return seg.start;
        }
      }
      if (offset > 0) {
        const tn = walkFrom(container.childNodes[offset - 1], true);
        if (tn) {
          const seg = flat.segments.find((s) => s.node === tn);
          if (seg) return seg.start + tn.nodeValue.length;
        }
      }
    }
    return null;
  }

  function occursOnce(haystack, needle) {
    if (!needle) return false;
    return haystack.split(needle).length - 1 === 1;
  }

  /** Grow [leftIdx, rightIdx) around the selection until the window is unique
   *  in the page text and padded >= HL_MIN_PAD on each side. */
  function computeContexts(fullDoc, selStart, selEnd) {
    if (selEnd - selStart < 1 || selStart < 0 || selEnd > fullDoc.length) {
      return null;
    }
    let leftIdx = selStart;
    let rightIdx = selEnd;
    while (true) {
      const unique = occursOnce(fullDoc, fullDoc.slice(leftIdx, rightIdx));
      const needLeft = selStart - leftIdx < HL_MIN_PAD;
      const needRight = rightIdx - selEnd < HL_MIN_PAD;
      if (unique && !needLeft && !needRight) break;
      const canLeft = leftIdx > 0;
      const canRight = rightIdx < fullDoc.length;
      if (!canLeft && !canRight) break;
      let progress = false;
      if (canRight && (!unique || needRight)) {
        rightIdx++;
        progress = true;
      }
      if (canLeft && (!unique || needLeft)) {
        leftIdx--;
        progress = true;
      }
      if (!progress) break;
    }
    return {
      text: normText(fullDoc.slice(selStart, selEnd)),
      left: normText(fullDoc.slice(leftIdx, selStart)),
      right: normText(fullDoc.slice(selEnd, rightIdx)),
    };
  }

  /** Wrap [start, end) of the flat text in <mark> elements (one per crossed
   *  text node). Returns the marks. */
  function wrapOffsets(flat, start, end, hlId) {
    const targets = [];
    for (const seg of flat.segments) {
      if (seg.end <= start || seg.start >= end) continue;
      targets.push({
        node: seg.node,
        from: Math.max(0, start - seg.start),
        to: Math.min(seg.node.nodeValue.length, end - seg.start),
      });
    }
    const marks = [];
    for (const t of targets) {
      if (t.to <= t.from) continue;
      let node = t.node;
      if (t.from > 0) node = node.splitText(t.from);
      if (t.to - t.from < node.nodeValue.length) node.splitText(t.to - t.from);
      const mark = document.createElement("mark");
      mark.className = "calm-papery-hl";
      if (hlId != null) mark.dataset.phlId = String(hlId);
      node.parentNode.insertBefore(mark, node);
      mark.appendChild(node);
      marks.push(mark);
    }
    return marks;
  }

  function contextMatches(flat, idx, text, left, right) {
    const lc = left.slice(-HL_MIN_PAD);
    const rc = right.slice(0, HL_MIN_PAD);
    if (lc && flat.text.slice(Math.max(0, idx - lc.length), idx) !== lc) {
      return false;
    }
    const after = flat.text.slice(idx + text.length, idx + text.length + rc.length);
    if (rc && after !== rc) return false;
    return true;
  }

  /** Anchor one stored highlight; returns true if it was wrapped. */
  function anchorHighlight(h) {
    const text = normText(h.text);
    if (!text || text.length < 2) return false;
    const flat = buildFlatTextMap();
    if (!flat.text.length) return false;
    const left = normText(h.left_ctx);
    const right = normText(h.right_ctx);
    // 1) exact context concat
    if (left || right) {
      const idx = flat.text.indexOf(left + text + right);
      if (idx !== -1 && occursOnce(flat.text, left + text + right)) {
        return wrapOffsets(flat, idx + left.length, idx + left.length + text.length, h.id).length > 0;
      }
    }
    // 2) occurrences of text, disambiguated by partial context
    let search = 0;
    while (true) {
      const idx = flat.text.indexOf(text, search);
      if (idx === -1) break;
      if (contextMatches(flat, idx, text, left, right)) {
        return wrapOffsets(flat, idx, idx + text.length, h.id).length > 0;
      }
      search = idx + 1;
    }
    // 3) first raw occurrence
    const idx = flat.text.indexOf(text);
    if (idx === -1) return false;
    return wrapOffsets(flat, idx, idx + text.length, h.id).length > 0;
  }

  function unwrapHighlight(id) {
    for (const mark of document.querySelectorAll(
      `mark.calm-papery-hl[data-phl-id="${id}"]`
    )) {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
  }

  function removeAllHighlightMarks() {
    for (const mark of document.querySelectorAll("mark.calm-papery-hl")) {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
  }

  function markCommented(id) {
    for (const m of document.querySelectorAll(
      `mark.calm-papery-hl[data-phl-id="${id}"]`
    )) {
      m.classList.add("calm-papery-hl--commented");
    }
  }

  function unmarkCommented(id) {
    for (const m of document.querySelectorAll(
      `mark.calm-papery-hl[data-phl-id="${id}"]`
    )) {
      m.classList.remove("calm-papery-hl--commented");
    }
  }

  async function saveNoteFromToolbar(id) {
    const val = hlToolbar
      ? hlToolbar.querySelector(".calm-papery-hl-note").value.trim()
      : "";
    hideHlToolbar();
    const res = await sendPapery("highlights.comment", { id, comment: val });
    if (!res.ok) {
      toast(describeError(res.error));
      return;
    }
    if (val) {
      hlComments[id] = val;
      markCommented(id);
      toast("Note saved");
    } else {
      delete hlComments[id];
      unmarkCommented(id);
      toast("Note removed");
    }
  }

  async function loadHighlights() {
    const res = await sendPapery("highlights.list", { url: pageUrl() });
    if (!res.ok || !Array.isArray(res.highlights)) return;
    for (const h of res.highlights) {
      try {
        if (anchorHighlight(h) && h.comment) {
          hlComments[h.id] = h.comment;
          markCommented(h.id);
        }
      } catch {}
    }
    refreshHlCycle();
  }

  // --- highlight cycler (dock button: scroll through highlights in order) ---

  let cycleBtn = null;
  let cycleIdx = -1;

  function anchoredHighlightIds() {
    const ids = [];
    for (const mark of document.querySelectorAll(
      "mark.calm-papery-hl[data-phl-id]"
    )) {
      const id = mark.dataset.phlId;
      if (!ids.includes(id)) ids.push(id); // DOM (reading) order
    }
    return ids;
  }

  function ensureCycleBtn() {
    if (cycleBtn || !dock || !btn) return;
    cycleBtn = document.createElement("button");
    cycleBtn.type = "button";
    cycleBtn.className = "calm-papery-btn calm-papery-btn--cycle";
    cycleBtn.innerHTML =
      SVG_HIGHLIGHTER + '<span class="calm-papery-cycle-badge"></span>';
    cycleBtn.addEventListener("click", cycleToNextHighlight);
    dock.insertBefore(cycleBtn, heartBtn || btn); // top of the button stack
  }

  function refreshHlCycle() {
    const ids = anchoredHighlightIds();
    if (!ids.length) {
      if (cycleBtn) cycleBtn.hidden = true;
      cycleIdx = -1;
      return;
    }
    ensureCycleBtn();
    if (!cycleBtn) return;
    cycleBtn.hidden = false;
    const label = `${ids.length} highlight${ids.length === 1 ? "" : "s"} — click to cycle`;
    cycleBtn.title = label;
    cycleBtn.setAttribute("aria-label", label);
    cycleBtn.querySelector(".calm-papery-cycle-badge").textContent =
      ids.length > 9 ? "9+" : String(ids.length);
  }

  function cycleToNextHighlight() {
    const ids = anchoredHighlightIds();
    if (!ids.length) return;
    cycleIdx = (cycleIdx + 1) % ids.length;
    const id = ids[cycleIdx];
    const marks = document.querySelectorAll(
      `mark.calm-papery-hl[data-phl-id="${id}"]`
    );
    if (!marks.length) return;
    marks[0].scrollIntoView({ behavior: "smooth", block: "center" });
    for (const m of marks) {
      m.classList.remove("calm-papery-hl--pulse");
      void m.offsetWidth; // restart the animation
      m.classList.add("calm-papery-hl--pulse");
    }
  }

  // --- highlight marker: floats at the end of a selection, one click marks --

  let markerEl = null;

  function ensureMarker() {
    if (markerEl) return;
    markerEl = document.createElement("button");
    markerEl.type = "button";
    markerEl.className = "calm-papery-hl-marker";
    markerEl.title = "Highlight";
    markerEl.setAttribute("aria-label", "Highlight selection");
    markerEl.innerHTML = SVG_HIGHLIGHTER;
    markerEl.addEventListener("mousedown", (e) => {
      // beat the selectionchange/mousedown hide, keep the selection alive
      e.preventDefault();
      e.stopPropagation();
      suppressNextMouseUp = true;
      void createHighlightFromSelection();
    });
    document.documentElement.appendChild(markerEl);
  }

  function showMarker(range) {
    ensureMarker();
    pendingRange = range.cloneRange();
    // Anchor beside the end of the selected text (last line), not the union
    // box — feels attached to what you just selected.
    const rects = range.getClientRects();
    const r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    markerEl.style.left = Math.min(r.right + 8, window.innerWidth - 34) + "px";
    markerEl.style.top =
      Math.max(4, Math.min(r.top + r.height / 2 - 12, window.innerHeight - 34)) + "px";
    markerEl.classList.add("calm-papery-hl-marker--show");
  }

  function hideMarker() {
    if (markerEl) markerEl.classList.remove("calm-papery-hl-marker--show");
    pendingRange = null;
  }

  // --- note pen: floats beside a highlight while hovering it ---

  const SVG_PEN = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;

  let penEl = null;
  let penFor = null;
  let penHideTimer = 0;

  function ensurePen() {
    if (penEl) return;
    penEl = document.createElement("button");
    penEl.type = "button";
    penEl.className = "calm-papery-hl-pen";
    penEl.innerHTML = SVG_PEN;
    penEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      suppressNextMouseUp = true;
      if (penFor == null) return;
      const id = Number(penFor);
      const mark = document.querySelector(
        `mark.calm-papery-hl[data-phl-id="${penFor}"]`
      );
      hidePen();
      if (mark) {
        showHlToolbar(mark.getBoundingClientRect(), { action: "note", id });
      }
    });
    document.documentElement.appendChild(penEl);
  }

  function showPen(mark) {
    ensurePen();
    window.clearTimeout(penHideTimer);
    penHideTimer = 0;
    penFor = mark.dataset.phlId;
    const r = mark.getBoundingClientRect();
    penEl.style.left = Math.min(r.right + 6, window.innerWidth - 30) + "px";
    penEl.style.top = Math.max(4, r.top + r.height / 2 - 11) + "px";
    const noted = !!hlComments[penFor];
    penEl.classList.toggle("calm-papery-hl-pen--noted", noted);
    penEl.title = noted ? "edit note" : "add note";
    penEl.setAttribute("aria-label", penEl.title);
    penEl.classList.add("calm-papery-hl-pen--show");
  }

  function hidePen() {
    if (penEl) penEl.classList.remove("calm-papery-hl-pen--show");
    penFor = null;
  }

  function schedulePenHide() {
    window.clearTimeout(penHideTimer);
    penHideTimer = window.setTimeout(hidePen, 180);
  }

  document.addEventListener("mouseover", (e) => {
    if (!config.enabled) return;
    const t = e.target;
    if (t && t.closest) {
      const mark = t.closest("mark.calm-papery-hl[data-phl-id]");
      if (mark) {
        showPen(mark);
        return;
      }
      if (t.closest(".calm-papery-hl-pen")) {
        window.clearTimeout(penHideTimer);
        penHideTimer = 0;
        return;
      }
    }
    if (penFor != null) schedulePenHide();
  });
  document.addEventListener("scroll", hidePen, true);

  // --- highlight toolbar ---

  function buildHlToolbar() {
    if (hlToolbar) return;
    hlToolbar = document.createElement("div");
    hlToolbar.id = HL_TOOLBAR_ID;
    hlToolbar.innerHTML =
      '<textarea class="calm-papery-hl-note" rows="2" maxlength="500" placeholder="note&hellip;"></textarea>' +
      '<button type="button" class="calm-papery-hl-btn"></button>';
    hlToolbar.querySelector("button").addEventListener("mousedown", (e) => {
      // beat the selectionchange/mousedown hide
      e.preventDefault();
      e.stopPropagation();
      suppressNextMouseUp = true;
      if (hlToolbarMode && hlToolbarMode.action === "remove")
        void removeHighlight(hlToolbarMode.id);
      else if (hlToolbarMode && hlToolbarMode.action === "note")
        void saveNoteFromToolbar(hlToolbarMode.id);
    });
    document.documentElement.appendChild(hlToolbar);
  }

  function showHlToolbar(rect, mode) {
    buildHlToolbar();
    hlToolbarMode = mode;
    const btn = hlToolbar.querySelector("button");
    const note = hlToolbar.querySelector(".calm-papery-hl-note");
    if (mode.action === "remove") {
      btn.textContent = "remove highlight";
      note.hidden = true;
    } else {
      btn.textContent = "save note";
      note.hidden = false;
      note.value = hlComments[mode.id] || "";
    }
    hlToolbar.style.left =
      Math.max(8, Math.min(rect.left, window.innerWidth - 280)) + "px";
    hlToolbar.style.top = Math.min(rect.bottom + 6, window.innerHeight - 120) + "px";
    hlToolbar.classList.add("calm-papery-hl-toolbar--show");
    if (mode.action === "note") {
      note.focus();
      note.setSelectionRange(note.value.length, note.value.length);
    }
  }

  function hideHlToolbar() {
    if (!hlToolbar) return;
    hlToolbar.classList.remove("calm-papery-hl-toolbar--show");
    hlToolbarMode = null;
  }

  async function createHighlightFromSelection() {
    const range = pendingRange;
    hideMarker();
    if (!range) return;
    const flat = buildFlatTextMap();
    const start = textNodeOffset(flat, range.startContainer, range.startOffset);
    const end = textNodeOffset(flat, range.endContainer, range.endOffset);
    if (start == null || end == null || end - start < 2) return;
    const ctx = computeContexts(flat.text, start, end);
    if (!ctx) return;
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    // optimistic wrap; tag with the real id when the save lands
    const marks = wrapOffsets(flat, start, end, null);
    const res = await sendPapery("highlights.add", {
      url: pageUrl(),
      text: ctx.text,
      left: ctx.left,
      right: ctx.right,
    });
    if (res.ok && res.id != null) {
      for (const m of marks) m.dataset.phlId = String(res.id);
      refreshHlCycle();
      toast("Highlighted");
    } else {
      for (const m of marks) {
        const parent = m.parentNode;
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        parent.removeChild(m);
        parent.normalize();
      }
      toast(describeError(res.error));
    }
  }

  async function removeHighlight(id) {
    hideHlToolbar();
    const res = await sendPapery("highlights.remove", { id });
    if (res.ok) {
      unwrapHighlight(id);
      delete hlComments[id];
      refreshHlCycle();
      toast("Highlight removed");
    } else {
      toast(describeError(res.error));
    }
  }

  function onMouseUp(e) {
    if (suppressNextMouseUp) {
      suppressNextMouseUp = false;
      return;
    }
    if (!config.enabled || !isConfigured()) return;
    if (e.target && e.target.closest && e.target.closest(`#${HL_TOOLBAR_ID}`)) {
      return;
    }
    if (e.target && e.target.closest && e.target.closest(".calm-papery-hl-pen")) {
      return; // pen mousedown just opened the note editor — don't hide it
    }
    if (
      e.target &&
      e.target.closest &&
      e.target.closest(".calm-papery-hl-marker")
    ) {
      return; // marker mousedown just created the highlight
    }
    // click on an existing highlight -> offer removal
    const mark =
      e.target && e.target.closest
        ? e.target.closest("mark.calm-papery-hl[data-phl-id]")
        : null;
    const sel = window.getSelection();
    const collapsed = !sel || sel.isCollapsed || !String(sel).trim();
    if (mark && collapsed) {
      hideMarker();
      showHlToolbar(mark.getBoundingClientRect(), {
        action: "remove",
        id: Number(mark.dataset.phlId),
      });
      return;
    }
    if (collapsed || String(sel).trim().length < 2 || sel.rangeCount === 0) {
      hideHlToolbar();
      hideMarker();
      return;
    }
    if (!state.saved) {
      // Highlighting only applies to papered pages — no marker otherwise.
      hideMarker();
      return;
    }
    const range = sel.getRangeAt(0);
    if (
      range.commonAncestorContainer &&
      range.commonAncestorContainer.parentElement &&
      range.commonAncestorContainer.parentElement.closest(`#${DOCK_ID}`)
    ) {
      return;
    }
    hideHlToolbar();
    showMarker(range);
  }

  document.addEventListener("mouseup", (e) => {
    // let the selection settle before reading it
    window.setTimeout(() => onMouseUp(e), 0);
  });
  document.addEventListener(
    "scroll",
    () => {
      hideHlToolbar();
      hideMarker();
    },
    true
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideHlToolbar();
      hideMarker();
    }
  });

  // --- lifecycle ------------------------------------------------------------

  let highlightsLoaded = false;

  async function apply() {
    await readConfig();
    if (config.enabled && isConfigured()) {
      buildDock();
      if (!highlightsLoaded) {
        highlightsLoaded = true;
        void loadHighlights();
      }
      await refreshState();
    } else {
      removeDock();
      hideHlToolbar();
      hideMarker();
      hidePen();
      removeAllHighlightMarks();
      highlightsLoaded = false;
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") {
      return;
    }
    if (
      "paperyEnabled" in changes ||
      "paperyEndpoint" in changes ||
      "paperyToken" in changes
    ) {
      void apply();
    }
  });

  // Popup <-> content messaging (mirrors the Curius save-toggle wiring). The
  // popup drives the same actions as the on-page button.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.scope !== "papery") {
      return false;
    }
    if (msg.type === "getPaperySaveState") {
      (async () => {
        await readConfig();
        if (!config.enabled) {
          sendResponse({ ok: false, error: "disabled" });
          return;
        }
        if (!isConfigured()) {
          sendResponse({ ok: false, error: "unconfigured" });
          return;
        }
        const res = await refreshState();
        sendResponse(res);
      })();
      return true;
    }
    if (msg.type === "togglePaperySaveFromPopup") {
      (async () => {
        await readConfig();
        if (!config.enabled) {
          sendResponse({ ok: false, error: "disabled" });
          return;
        }
        if (!isConfigured()) {
          sendResponse({ ok: false, error: "unconfigured" });
          return;
        }
        if (!dock) {
          buildDock();
        }
        const res = await toggleSave();
        sendResponse(res);
      })();
      return true;
    }
    return false;
  });

  void apply();

  // Exposed for tests only — content scripts run in an isolated world, so
  // page scripts never see this in production.
  window.__calmPaperyTest = {
    buildFlatTextMap,
    textNodeOffset,
    computeContexts,
    wrapOffsets,
    anchorHighlight,
    unwrapHighlight,
    normText,
    refreshHlCycle,
    cycleToNextHighlight,
    anchoredHighlightIds,
  };
})();
