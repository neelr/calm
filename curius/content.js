/**
 * Curius: minimal top-right dock (savers as avatars), selection → highlight + comment,
 * on-page marks, and comment bubbles fixed near each highlight (hover links pair).
 * Network calls only when Curius is enabled in the Calm Feed popup.
 */
(function () {
  const DOCK_ID = "calm-curius-dock";
  const TOOLBAR_ID = "calm-curius-seltoolbar";
  const COMMENT_PANEL_ID = "calm-curius-comment-panel";
  let dockEl = null;
  let toolbarEl = null;
  let commentPanelEl = null;
  let hlKeySeq = 0;
  let lastLink = null;
  let dockCollapsed = false;
  let toastTimer = null;
  let currentUserId = null;
  let currentUserProfile = null;
  let optimisticSavedByMe = false;
  /** Dock avatar: each click cycles that person’s on-page highlights (wraps). */
  let dockNavPersonKey = null;
  let dockNavIndex = -1;
  let inlineDeleteOutsideDismissBound = false;
  let visualViewportScrollBound = false;
  /** Captured when toolbar opens so typing in the comment textarea doesn't lose it. */
  let pendingSelRange = null;
  let pendingSelText = null;

  /** Set to `false` to silence `[Calm Curius]` logs (page DevTools console). */
  const CURIUS_DEBUG = true;
  function curiusDbg(...args) {
    if (!CURIUS_DEBUG) {
      return;
    }
    try {
      console.log("[Calm Curius]", ...args);
    } catch (_) {
      /* ignore */
    }
  }
  const NETWORK_SAVED_FLAG_KEYS = [
    "viewerSaved",
    "viewerHasSaved",
    "hasSaved",
    "savedByViewer",
    "userSaved",
    "saved",
  ];

  /**
   * Match how Curius stores URLs: strip hash and `curius` share param so
   * `POST /api/links/url` finds the same row as when the page was saved.
   */
  function urlForCuriusApi(href) {
    try {
      const u = new URL(href);
      u.hash = "";
      u.searchParams.delete("curius");
      return u.toString();
    } catch {
      return href;
    }
  }

  /**
   * Whether you saved a page: `GET /api/linkview/:id` includes `fullLink` when the
   * authenticated viewer has saved that link (per Curius API docs). The link object
   * may also include `userIds` including your id. Savers list: network `users`, etc.
   */
  function buildSaversList(link, me) {
    if (!link) {
      return [];
    }
    let list = [];
    const raw = link.users;
    if (Array.isArray(raw) && raw.length > 0) {
      list = raw.slice();
    } else {
      const cb = link.createdBy;
      if (cb != null && me && String(cb) === String(me.id)) {
        list = [me];
      }
    }
    if (
      me &&
      viewerShouldAppearAsSaver(link, me) &&
      !list.some((u) => saverMatchesMe(u, me))
    ) {
      return [me, ...list];
    }
    return list;
  }

  function extractCuriusUserObject(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }
    if (
      data.message === "Unauthenticated" ||
      data.error === "Unauthenticated"
    ) {
      return null;
    }
    if (data.user && typeof data.user === "object") {
      return data.user;
    }
    if (data.data && typeof data.data === "object") {
      if (data.data.user && typeof data.data.user === "object") {
        return data.data.user;
      }
      if (!Array.isArray(data.data)) {
        return data.data;
      }
    }
    return data;
  }

  function saverMatchesMe(u, me) {
    if (!u || !me) {
      return false;
    }
    if (me.id != null && u.id != null && String(u.id) === String(me.id)) {
      return true;
    }
    if (me.uid != null && u.uid != null && String(u.uid) === String(me.uid)) {
      return true;
    }
    if (u.userLink && me.userLink) {
      return (
        String(u.userLink).toLowerCase() === String(me.userLink).toLowerCase()
      );
    }
    return false;
  }

  function linkSaysViewerSaved(link) {
    if (!link || typeof link !== "object") {
      return false;
    }
    for (const k of NETWORK_SAVED_FLAG_KEYS) {
      if (link[k] === true) {
        return true;
      }
    }
    return false;
  }

  /**
   * Same signals as `isSavedByMe` except the “already in `link.users`” check — used so we
   * can append the viewer to the savers list when the API omits them from `users`.
   */
  function viewerShouldAppearAsSaver(link, me) {
    if (!link || link.id == null) {
      return false;
    }
    if (optimisticSavedByMe) {
      return true;
    }
    if (link.viewerHasSaved === true) {
      return true;
    }
    if (currentUserId != null && userIdInList(link.userIds, currentUserId)) {
      return true;
    }
    if (linkSaysViewerSaved(link)) {
      return true;
    }
    if (currentUserId == null && !currentUserProfile) {
      return false;
    }
    if (currentUserId != null) {
      if (String(link.createdBy) === String(currentUserId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * `GET /api/linkview/:id` sets `viewerHasSaved` via `fullLink`, and may set `userIds`.
   * Do not use `link.id` alone — that only means the URL exists on Curius for someone.
   */
  function isSavedByMe(link) {
    if (!link || link.id == null) {
      return false;
    }
    if (optimisticSavedByMe) {
      return true;
    }
    if (link.viewerHasSaved === true) {
      return true;
    }
    if (currentUserId != null && userIdInList(link.userIds, currentUserId)) {
      return true;
    }
    if (linkSaysViewerSaved(link)) {
      return true;
    }
    if (currentUserId == null && !currentUserProfile) {
      return false;
    }
    if (currentUserId != null) {
      if (String(link.createdBy) === String(currentUserId)) {
        return true;
      }
    }
    const users = buildSaversList(link, currentUserProfile);
    return users.some((u) => saverMatchesMe(u, currentUserProfile));
  }

  function sendCurius(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ scope: "curius", type, ...payload }, resolve);
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function userLabel(u) {
    if (u == null) {
      return "Someone";
    }
    if (typeof u === "string") {
      const s = u.trim();
      return s || "Someone";
    }
    if (typeof u !== "object") {
      return "Someone";
    }
    const n = [u.firstName || u.first_name, u.lastName || u.last_name]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (n) {
      return n;
    }
    const dn = u.displayName || u.display_name;
    if (dn && String(dn).trim()) {
      return String(dn).trim();
    }
    if (u.name && String(u.name).trim()) {
      return String(u.name).trim();
    }
    if (u.userLink) {
      return `@${u.userLink}`;
    }
    if (u.username && String(u.username).trim()) {
      return String(u.username).trim();
    }
    if (u.email && String(u.email).trim()) {
      return String(u.email).trim();
    }
    return "Someone";
  }

  /**
   * Full user object for a highlight, including lookup by id in `lastLink.users`
   * when the API only sends `userId` on the highlight row.
   */
  function highlightUserObject(h) {
    if (!h || typeof h !== "object") {
      return null;
    }
    const fromComment =
      h.comment && typeof h.comment === "object" ? h.comment.user : null;
    const direct =
      h.user ||
      (typeof h.author === "object" && h.author ? h.author : null) ||
      (Array.isArray(h.users) && h.users[0]) ||
      fromComment ||
      null;
    if (direct && typeof direct === "object") {
      return direct;
    }
    const uid =
      h.userId ??
      h.user_id ??
      h.createdBy ??
      h.created_by ??
      (typeof h.author === "number" || typeof h.author === "string"
        ? h.author
        : null);
    if (uid != null && lastLink && Array.isArray(lastLink.users)) {
      const found = lastLink.users.find(
        (u) => u && u.id != null && String(u.id) === String(uid)
      );
      if (found) {
        return found;
      }
    }
    return null;
  }

  /**
   * Same person key as dock avatars (`personKeyFromUser(u) || userLabel(u)`), so comment
   * badges match. Highlights by “you” often omit you from `link.users`; resolve via
   * `userId` + `currentUserProfile` when needed.
   */
  function personKeyForHighlightComment(h) {
    if (!h || typeof h !== "object") {
      return "";
    }
    const uo = highlightUserObject(h);
    if (uo) {
      return personKeyFromUser(uo) || userLabel(uo);
    }
    const uid = h.userId ?? h.user_id ?? null;
    if (uid != null && lastLink && Array.isArray(lastLink.users)) {
      const found = lastLink.users.find(
        (u) => u && u.id != null && String(u.id) === String(uid)
      );
      if (found) {
        return personKeyFromUser(found) || userLabel(found);
      }
    }
    if (
      uid != null &&
      currentUserId != null &&
      String(uid) === String(currentUserId) &&
      currentUserProfile
    ) {
      return (
        personKeyFromUser(currentUserProfile) ||
        userLabel(currentUserProfile)
      );
    }
    return highlightUser(h) || "";
  }

  function personKeyFromUser(u) {
    if (!u || typeof u !== "object") {
      return "";
    }
    if (u.id != null) {
      return `id:${String(u.id)}`;
    }
    if (u.userLink) {
      return `u:${String(u.userLink).toLowerCase()}`;
    }
    return userLabel(u);
  }

  function hashStringToHue(str) {
    let h = 0;
    const s = String(str || "");
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return h % 360;
  }

  /** Stable HSL from name key — same person → same color everywhere. */
  function personVisuals(nameKey) {
    const hue = hashStringToHue(nameKey || "unknown");
    return {
      hue,
      avatarBg: `hsl(${hue}, 58%, 46%)`,
      markBg: `hsla(${hue}, 72%, 88%, 0.92)`,
      markBorder: `hsla(${hue}, 58%, 42%, 0.88)`,
    };
  }

  function avatarInitial(u) {
    if (!u || typeof u !== "object") {
      return "?";
    }
    const fn = String(u.firstName || "").trim();
    if (fn) {
      return fn.charAt(0).toUpperCase();
    }
    const link = String(u.userLink || "").replace(/^@/, "");
    if (link) {
      return link.charAt(0).toUpperCase();
    }
    return "?";
  }

  function visualsForHighlight(h) {
    const uo = highlightUserObject(h);
    const key =
      (uo && personKeyFromUser(uo)) ||
      highlightUser(h) ||
      String(highlightId(h) || "");
    return personVisuals(key);
  }

  function visualsForMe() {
    if (currentUserProfile && typeof currentUserProfile === "object") {
      return personVisuals(
        personKeyFromUser(currentUserProfile) || "me"
      );
    }
    return personVisuals("me");
  }

  /**
   * `POST /api/links/url` often returns `{ link: null }` when you have not saved
   * the URL yourself, even if it exists on Curius. Network (`/api/links/url/network`)
   * may still return `link` + savers — merge that in `mergeLinkWithNetwork`.
   */
  function extractLink(res) {
    const d = res?.data;
    if (!d) {
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(d, "link")) {
      const inner = d.link;
      return inner && typeof inner === "object" ? inner : null;
    }
    return d;
  }

  function firstNonEmptyUserArray(...candidates) {
    for (const c of candidates) {
      if (Array.isArray(c) && c.length > 0) {
        return c;
      }
    }
    return null;
  }

  function extractNetworkInfo(res) {
    const d = res?.data;
    if (!d || typeof d !== "object") {
      return null;
    }
    if (d.networkInfo && typeof d.networkInfo === "object") {
      const ni = { ...d.networkInfo };
      const merged = firstNonEmptyUserArray(
        ni.users,
        d.users,
        d.link && d.link.users
      );
      if (merged) {
        ni.users = merged;
      }
      return ni;
    }
    return d;
  }

  function mergeLinkWithNetwork(link, networkInfo, rawNetworkData) {
    if (!networkInfo || typeof networkInfo !== "object") {
      return link;
    }
    let out = link ? { ...link } : null;
    const nl =
      rawNetworkData &&
      rawNetworkData.link &&
      typeof rawNetworkData.link === "object"
        ? rawNetworkData.link
        : null;
    if ((!out || out.id == null) && nl) {
      out = { ...nl, ...out };
    }
    /* `/api/links/url/network` often returns the row only on `networkInfo`, with
       `link` as a URL string (not a nested object). `POST /api/links/url` can
       still be `{ link: null }` — bootstrap id + users from `networkInfo`. */
    if ((!out || out.id == null) && networkInfo.id != null) {
      const ni = { ...networkInfo };
      const nh = normalizeHighlightsFromApi(ni.highlights);
      if (nh.length > 0) {
        ni.highlights = nh;
      } else {
        delete ni.highlights;
      }
      out = { ...ni, ...out };
    }
    if (!out) {
      return null;
    }
    if (Array.isArray(networkInfo.users) && networkInfo.users.length > 0) {
      out.users = networkInfo.users;
    }
    for (const k of NETWORK_SAVED_FLAG_KEYS) {
      if (Object.prototype.hasOwnProperty.call(networkInfo, k)) {
        out[k] = networkInfo[k];
      }
    }
    const netHl = normalizeHighlightsFromApi(networkInfo.highlights);
    if (netHl.length > 0) {
      out.highlights = mergeHighlightsById(
        normalizeHighlightsFromApi(out.highlights),
        netHl
      );
    }
    return out;
  }

  /**
   * @param {object} viewData - body from GET /api/linkview/:id (`{ link?, fullLink? }`)
   */
  function mergeLinkView(link, viewData) {
    if (!link || !viewData || typeof viewData !== "object") {
      return link;
    }
    const preservedUsers = firstNonEmptyUserArray(link.users);
    const preservedHl = normalizeHighlightsFromApi(link.highlights);
    const out = { ...link };
    if (Object.prototype.hasOwnProperty.call(viewData, "fullLink")) {
      // fullLink is present for any authenticated user, not just savers.
      // Cross-check with userIds to determine if *we* actually saved it.
      const innerIds = viewData.link && Array.isArray(viewData.link.userIds)
        ? viewData.link.userIds
        : null;
      if (innerIds && currentUserId != null) {
        out.viewerHasSaved = userIdInList(innerIds, currentUserId);
      } else {
        out.viewerHasSaved = !!viewData.fullLink;
      }
    }
    const inner = viewData.link;
    if (inner && Array.isArray(inner.userIds)) {
      out.userIds = inner.userIds;
    }
    if (inner && Array.isArray(inner.users) && inner.users.length > 0) {
      // Keep whichever list is larger — linkview often returns a subset
      if (preservedUsers && preservedUsers.length >= inner.users.length) {
        out.users = preservedUsers;
      } else {
        out.users = inner.users;
      }
    } else if (preservedUsers) {
      out.users = preservedUsers;
    }
    let mergedHl = preservedHl;
    if (inner) {
      const innerHl = normalizeHighlightsFromApi(inner.highlights);
      if (innerHl.length > 0) {
        mergedHl = mergeHighlightsById(mergedHl, innerHl);
      }
    }
    /* Official Curius extension: linkview often puts network highlights in `link.highlights`
     * (nested arrays) and viewer-specific rows in `fullLink.highlights` — merge both. */
    const full = viewData.fullLink;
    if (full && full.highlights != null) {
      const fullHl = normalizeHighlightsFromApi(full.highlights);
      if (fullHl.length > 0) {
        mergedHl = mergeHighlightsById(mergedHl, fullHl);
      }
    }
    if (mergedHl.length > 0) {
      out.highlights = mergedHl;
    } else if (preservedHl.length > 0) {
      out.highlights = preservedHl;
    }
    out.highlights = normalizeHighlightsFromApi(out.highlights);
    return out;
  }

  function userIdInList(ids, userId) {
    if (!Array.isArray(ids) || userId == null) {
      return false;
    }
    const s = String(userId);
    return ids.some((id) => String(id) === s);
  }

  /**
   * `POST /api/links/url/network` returns `networkInfo.highlights` as one array per
   * `networkInfo.users` entry (often many empty `[]`). Flatten to a single list.
   */
  function normalizeHighlightsFromApi(raw) {
    if (raw == null || !Array.isArray(raw)) {
      return [];
    }
    const flat = raw.flat(Infinity);
    const out = [];
    for (const item of flat) {
      if (item == null) {
        continue;
      }
      if (typeof item === "string") {
        out.push(item);
        continue;
      }
      if (typeof item === "object" && !Array.isArray(item)) {
        out.push(item);
      }
    }
    return out;
  }

  function extractHighlights(link) {
    if (!link) {
      return [];
    }
    return normalizeHighlightsFromApi(link.highlights);
  }

  function highlightText(h) {
    if (typeof h === "string") {
      return h;
    }
    if (!h || typeof h !== "object") {
      return "";
    }
    if (typeof h.highlight === "string" && h.highlight.length > 0) {
      return h.highlight;
    }
    return (
      h.text ||
      h.highlightText ||
      h.snippet ||
      (typeof h.highlight === "object" &&
        h.highlight &&
        (h.highlight.text || h.highlight.highlightText)) ||
      (typeof h.rawHighlight === "string" ? h.rawHighlight : "") ||
      ""
    );
  }

  function highlightUser(h) {
    const u = h.user || h.author || (Array.isArray(h.users) && h.users[0]);
    return userLabel(u);
  }

  function highlightId(h) {
    return h.id != null ? String(h.id) : "";
  }

  /**
   * Curius highlight rows may use `comment: string`, `comment: { text }`, or
   * top-level `commentText` (linkview / feed shapes differ).
   */
  function highlightCommentText(h) {
    if (!h || typeof h !== "object") {
      return "";
    }
    const topCommentKeys = [
      "commentText",
      "comment_text",
      "commentBody",
      "comment_body",
    ];
    for (const k of topCommentKeys) {
      const v = h[k];
      if (typeof v === "string" && v.trim()) {
        return v.trim();
      }
    }
    const c = h.comment;
    if (c == null) {
      return "";
    }
    if (typeof c === "string") {
      return c.trim();
    }
    if (Array.isArray(c)) {
      const parts = c
        .map((x) =>
          typeof x === "string"
            ? x.trim()
            : x && typeof x === "object"
              ? highlightCommentText({ comment: x })
              : ""
        )
        .filter(Boolean);
      return parts.length ? parts.join("\n") : "";
    }
    if (typeof c === "object" && c) {
      for (const key of [
        "text",
        "commentText",
        "comment_text",
        "body",
        "content",
        "message",
        "value",
        "markdown",
        "html",
      ]) {
        const v = c[key];
        if (typeof v === "string" && v.trim()) {
          return v.trim();
        }
      }
    }
    return "";
  }

  /**
   * Merge two highlight rows with the same id from different linkview sources.
   * `{ ...a, ...b }` alone is unsafe: b can overwrite a.comment with null while
   * leaving a stale commentText, so highlightCommentText(merged) reads the wrong field.
   * Pick the side with longer extracted comment text, then copy all comment keys from
   * that row; drop keys the winner does not define so loser values cannot linger.
   */
  function mergeHighlightRows(a, b) {
    const ta = highlightCommentText(a);
    const tb = highlightCommentText(b);
    const merged = { ...a, ...b };
    if (!ta && !tb) {
      return merged;
    }
    const win = ta.length >= tb.length ? a : b;
    const commentKeys = [
      "comment",
      "commentText",
      "comment_text",
      "commentBody",
      "comment_body",
    ];
    for (const k of commentKeys) {
      if (Object.prototype.hasOwnProperty.call(win, k)) {
        merged[k] = win[k];
      } else {
        delete merged[k];
      }
    }
    return merged;
  }

  function mergeHighlightsById(a, b) {
    const byId = new Map();
    const noId = [];
    for (const h of [...a, ...b]) {
      if (!h || typeof h !== "object") {
        continue;
      }
      if (h.id == null) {
        noId.push(h);
      } else {
        const id = String(h.id);
        const prev = byId.get(id);
        if (prev) {
          byId.set(id, mergeHighlightRows(prev, h));
        } else {
          byId.set(id, h);
        }
      }
    }
    return [...byId.values(), ...noId];
  }

  function highlightCommentAuthorLabel(h) {
    const c = h && typeof h === "object" ? h.comment : null;
    if (!c || typeof c !== "object") {
      return "";
    }
    if (c.user && typeof c.user === "object") {
      return userLabel(c.user);
    }
    return "";
  }

  function applyHighlightMarkAppearance(mark, attrs) {
    if (!mark || !attrs) {
      return;
    }
    const bg = attrs.markBg;
    const bd = attrs.markBorder;
    if (bg) {
      mark.style.backgroundColor = bg;
    }
    if (bd) {
      mark.style.borderBottomColor = bd;
    }
  }

  function makeHlPairKey(attrs) {
    if (attrs && attrs.id != null && String(attrs.id) !== "") {
      return `h-${String(attrs.id)}`;
    }
    hlKeySeq += 1;
    return `t-${hlKeySeq}`;
  }

  /** Margin comments: each comment is an absolutely-positioned card in the right margin. */
  let marginComments = []; // { el, key, outerEl }

  function pairHoverHlComment(key, active) {
    const outer = document.querySelector(
      `.calm-curius-hl-outer[data-calm-hl-key="${key}"]`
    );
    const card = document.querySelector(
      `.calm-curius-margin-comment[data-calm-hl-key="${key}"]`
    );
    const outerOwn = outer && outer.dataset.calmHlOwn === "1";
    const cardOwn = card && card.dataset.calmHlOwn === "1";
    /* Pair ring/shadow only for your highlights — not other people’s margin comments. */
    const pairOuter =
      active && outerOwn && (!card || cardOwn);
    const pairCard = active && !!card && outerOwn && cardOwn;
    if (outer) {
      outer.classList.toggle("calm-curius-hl-outer--pair", pairOuter);
    }
    if (card) {
      card.classList.toggle("calm-curius-margin-comment--pair", pairCard);
    }
  }

  function bindPairHover(outer, key) {
    outer.addEventListener("mouseenter", () => pairHoverHlComment(key, true));
    outer.addEventListener("mouseleave", () => pairHoverHlComment(key, false));
  }

  function isOwnHighlightAttrs(attrs) {
    if (!attrs) {
      return false;
    }
    if (attrs.isMine === true) {
      return true;
    }
    if (currentUserId != null && attrs.userId != null) {
      if (String(attrs.userId) === String(currentUserId)) {
        return true;
      }
    }
    if (currentUserProfile && attrs.personKey) {
      const mePk =
        personKeyFromUser(currentUserProfile) ||
        userLabel(currentUserProfile);
      if (mePk && attrs.personKey === mePk) {
        return true;
      }
    }
    return false;
  }

  async function deleteHighlightForMarginCard(outerEl, card, attrs) {
    const hlText = attrs && attrs.highlightText ? String(attrs.highlightText) : "";
    const linkId = lastLink && lastLink.id != null ? lastLink.id : null;
    if (!hlText || linkId == null) {
      setStatus("Could not delete highlight.");
      return;
    }
    setStatus("");
    const res = await sendCurius("deleteHighlight", {
      linkId,
      highlightText: hlText,
    });
    if (res?.disabled) {
      return;
    }
    if (!res?.ok) {
      setStatus("Could not delete highlight.");
      return;
    }
    const outer =
      outerEl && outerEl.closest
        ? outerEl.closest(".calm-curius-hl-outer") || outerEl
        : null;
    if (outer && outer.parentNode) {
      unwrapHighlightOuter(outer);
    } else if (card && card.isConnected) {
      card.remove();
      marginComments = marginComments.filter((mc) => mc.el !== card);
    }
    await refreshLinkData();
  }

  function createMarginComment(key, attrs, accent, outerEl) {
    const card = document.createElement("div");
    card.className = "calm-curius-margin-comment";
    card.dataset.calmHlKey = key;
    if (accent) {
      card.style.setProperty("--row-accent", accent);
    }
    const dn = (attrs && (attrs.displayName || attrs.user)) || "";
    const own = isOwnHighlightAttrs(attrs);
    if (own) {
      card.dataset.calmHlOwn = "1";
      const head = document.createElement("div");
      head.className = "calm-curius-margin-comment-head";
      if (dn) {
        const nameEl = document.createElement("div");
        nameEl.className = "calm-curius-margin-comment-name";
        nameEl.textContent = dn;
        head.appendChild(nameEl);
      }
      const del = document.createElement("button");
      del.type = "button";
      del.className = "calm-curius-margin-comment-delete";
      del.setAttribute("aria-label", "Delete highlight");
      del.textContent = "×";
      del.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void deleteHighlightForMarginCard(outerEl, card, attrs);
      });
      head.appendChild(del);
      card.appendChild(head);
    } else if (dn) {
      const nameEl = document.createElement("div");
      nameEl.className = "calm-curius-margin-comment-name";
      nameEl.textContent = dn;
      card.appendChild(nameEl);
    }
    const textEl = document.createElement("div");
    textEl.className = "calm-curius-margin-comment-text";
    const commentShown = highlightCommentText(attrs);
    textEl.textContent = commentShown;
    card.appendChild(textEl);
    card.title = dn ? `${dn}: ${commentShown}` : commentShown;
    card.addEventListener("mouseenter", () => pairHoverHlComment(key, true));
    card.addEventListener("mouseleave", () => pairHoverHlComment(key, false));
    card.addEventListener("click", (e) => {
      if (e.target.closest(".calm-curius-margin-comment-delete")) {
        return;
      }
      if (!outerEl || !outerEl.isConnected) {
        return;
      }
      const mark = outerEl.querySelector(
        "mark.calm-curius-hl-server, mark.calm-curius-hl-mine"
      );
      if (!mark) {
        return;
      }
      const target = scrollTargetForMark(mark);
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      window.setTimeout(() => pulseHighlightNav(mark), 240);
    });
    // Make card draggable
    let dragStartX, dragStartY, cardStartX, cardStartY;
    card.addEventListener("mousedown", (e) => {
      if (e.target.closest("button, a, input, textarea, .calm-curius-margin-comment-text")) return;
      e.preventDefault();
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const rect = card.getBoundingClientRect();
      cardStartX = rect.left;
      cardStartY = rect.top + window.scrollY;
      card.dataset.dragged = "1";
      card.style.cursor = "grabbing";
      function onMove(ev) {
        const dx = ev.clientX - dragStartX;
        const dy = ev.clientY - dragStartY;
        card.style.top = `${cardStartY + dy}px`;
        card.style.right = "auto";
        card.style.left = `${cardStartX + dx}px`;
      }
      function onUp() {
        card.style.cursor = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    document.documentElement.appendChild(card);
    marginComments.push({ el: card, key, outerEl });
    layoutMarginComments();
  }

  /** Position all margin comment cards near their highlights, pushing down to avoid overlap. */
  function layoutMarginComments() {
    const GAP = 6;
    let nextAvailableTop = 0;
    // Split into anchored (has outerEl) and orphaned (no outerEl)
    const anchored = [];
    const orphaned = [];
    for (const mc of marginComments) {
      if (!mc.el.isConnected || mc.el.dataset.dragged) continue;
      if (mc.outerEl && mc.outerEl.isConnected) {
        const rect = mc.outerEl.getBoundingClientRect();
        anchored.push({ ...mc, docTop: rect.top + window.scrollY });
      } else {
        orphaned.push(mc);
      }
    }
    anchored.sort((a, b) => a.docTop - b.docTop);
    for (const entry of anchored) {
      let top = Math.max(entry.docTop, nextAvailableTop);
      entry.el.style.top = `${Math.round(top)}px`;
      nextAvailableTop = top + entry.el.offsetHeight + GAP;
    }
    // Place orphaned comments after the last anchored one
    for (const mc of orphaned) {
      mc.el.style.top = `${Math.round(nextAvailableTop)}px`;
      nextAvailableTop += mc.el.offsetHeight + GAP;
    }
  }

  function scheduleLayoutMarginComments() {
    requestAnimationFrame(layoutMarginComments);
  }

  function clearMarginComments() {
    for (const mc of marginComments) {
      if (mc.el.isConnected) {
        mc.el.remove();
      }
    }
    marginComments = [];
  }

  /** One document listener: disarm inline-delete “pinned” state on outside tap. */
  function ensureInlineDeleteOutsideDismiss() {
    if (inlineDeleteOutsideDismissBound) {
      return;
    }
    inlineDeleteOutsideDismissBound = true;
    function dismissArmed(e) {
      document
        .querySelectorAll(".calm-curius-hl-outer--inline-delete-armed")
        .forEach((el) => {
          if (el.isConnected && !el.contains(e.target)) {
            el.classList.remove("calm-curius-hl-outer--inline-delete-armed");
          }
        });
    }
    document.addEventListener("mousedown", dismissArmed, true);
    document.addEventListener("touchstart", dismissArmed, true);
  }

  /** Wrap highlight in outer span; if it has a comment, create a margin card. */
  function attachHighlightCallout(mark, attrs) {
    const parent = mark.parentNode;
    if (!parent) {
      return;
    }
    if (mark.closest(".calm-curius-hl-outer")) {
      return;
    }
    const outer = document.createElement("span");
    outer.className = "calm-curius-hl-outer";
    const key = makeHlPairKey(attrs);
    outer.dataset.calmHlKey = key;
    if (attrs && attrs.id) {
      outer.dataset.highlightId = String(attrs.id);
    }
    const accent = attrs && attrs.markBorder;
    if (accent) {
      outer.style.setProperty("--callout-accent", accent);
    }
    if (attrs && attrs.personKey) {
      outer.dataset.personKey = String(attrs.personKey);
    }
    parent.insertBefore(outer, mark);
    outer.appendChild(mark);
    const dn = (attrs && (attrs.displayName || attrs.user)) || "";
    outer.title = dn || "";

    const merged = { ...attrs };
    if (mark.classList && mark.classList.contains("calm-curius-hl-mine")) {
      merged.isMine = true;
    }
    if (isOwnHighlightAttrs(merged)) {
      outer.dataset.calmHlOwn = "1";
    }
    const cmt = highlightCommentText(merged);
    if (cmt) {
      createMarginComment(key, merged, accent, outer);
      outer.addEventListener("click", (e) => {
        if (e.target.closest(".calm-curius-hl-delete")) {
          return;
        }
        const card = document.querySelector(
          `.calm-curius-margin-comment[data-calm-hl-key="${key}"]`
        );
        if (!card || !card.isConnected) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        card.scrollIntoView({ block: "center", behavior: "smooth" });
        window.setTimeout(() => pulseMarginCommentNav(card), 240);
      });
    }
    bindPairHover(outer, key);
    /* Curius often returns comment: null — no margin card; still offer delete on own highlights. */
    if (isOwnHighlightAttrs(merged) && !cmt) {
      attachInlineDeleteOnOuter(outer, merged);
    }
  }

  function attachInlineDeleteOnOuter(outer, attrs) {
    outer.classList.add("calm-curius-hl-outer--inline-delete");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "calm-curius-hl-delete";
    btn.setAttribute("aria-label", "Delete highlight");
    btn.title = "Delete highlight";
    btn.textContent = "×";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      outer.classList.remove("calm-curius-hl-outer--inline-delete-armed");
      void deleteHighlightForMarginCard(outer, null, attrs);
    });
    outer.appendChild(btn);

    /* Click highlight to pin × open (hover alone failed crossing the gap; touch has no hover). */
    outer.addEventListener("click", (e) => {
      if (e.target === btn || btn.contains(e.target)) {
        return;
      }
      outer.classList.add("calm-curius-hl-outer--inline-delete-armed");
    });

    ensureInlineDeleteOutsideDismiss();
  }

  function pageSnippet() {
    const meta = document.querySelector('meta[name="description"]');
    if (meta && meta.content) {
      return meta.content.replace(/\s+/g, " ").trim().slice(0, 400);
    }
    const t = document.body ? document.body.innerText : "";
    return t.replace(/\s+/g, " ").trim().slice(0, 400) || "N/A";
  }

  function unwrapMark(mark) {
    const parent = mark.parentNode;
    if (!parent) {
      return;
    }
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
  }

  function unwrapHighlightOuter(outer) {
    const mark = outer.querySelector(
      "mark.calm-curius-hl-server, mark.calm-curius-hl-mine"
    );
    if (!mark) {
      outer.remove();
      return;
    }
    const parent = outer.parentNode;
    if (!parent) {
      return;
    }
    const hlKey = outer.dataset.calmHlKey;
    if (hlKey) {
      const card = document.querySelector(
        `.calm-curius-margin-comment[data-calm-hl-key="${hlKey}"]`
      );
      if (card) {
        card.remove();
        marginComments = marginComments.filter((mc) => mc.key !== hlKey);
      }
    }
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, outer);
    }
    parent.removeChild(outer);
  }

  function clearServerMarks() {
    clearMarginComments();
    document.querySelectorAll(".calm-curius-hl-outer").forEach((outer) => {
      if (outer.querySelector("mark.calm-curius-hl-server")) {
        unwrapHighlightOuter(outer);
      }
    });
    document.querySelectorAll("mark.calm-curius-hl-server").forEach(unwrapMark);
  }

  function clearMineMarks() {
    document.querySelectorAll(".calm-curius-hl-outer").forEach((outer) => {
      if (outer.querySelector("mark.calm-curius-hl-mine")) {
        unwrapHighlightOuter(outer);
      }
    });
    document.querySelectorAll("mark.calm-curius-hl-mine").forEach(unwrapMark);
  }

  function normalizeWs(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function acceptHighlightTextNode(node) {
    if (!node.nodeValue || !node.parentElement) {
      return false;
    }
    if (
      node.parentElement.closest(
        `#${DOCK_ID}, #${TOOLBAR_ID}, #${COMMENT_PANEL_ID}, script, style, noscript`
      )
    ) {
      return false;
    }
    return true;
  }

  /** Curius `z()`: normalize newlines for highlight payloads. */
  function zCurius(s) {
    return String(s || "").replace(/(\r\n|\r)/g, "\n");
  }

  function firstTextNodeInSubtreeForFlat(root, flat) {
    if (!root) {
      return null;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return acceptHighlightTextNode(node)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      if (flat.segments.some((s) => s.node === n)) {
        return n;
      }
    }
    return null;
  }

  function lastTextNodeInSubtreeForFlat(root, flat) {
    if (!root) {
      return null;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return acceptHighlightTextNode(node)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    let n;
    let last = null;
    while ((n = walker.nextNode())) {
      if (flat.segments.some((s) => s.node === n)) {
        last = n;
      }
    }
    return last;
  }

  function boundaryPointToGlobalOffset(container, offset, flat) {
    if (!flat || !flat.segments) {
      return null;
    }
    if (container.nodeType === Node.TEXT_NODE) {
      const seg = flat.segments.find((s) => s.node === container);
      if (!seg) {
        return null;
      }
      const mx = container.nodeValue.length;
      return seg.start + Math.min(Math.max(0, offset), mx);
    }
    if (container.nodeType === Node.ELEMENT_NODE) {
      if (offset < container.childNodes.length) {
        const child = container.childNodes[offset];
        const tn = firstTextNodeInSubtreeForFlat(child, flat);
        if (tn) {
          const seg = flat.segments.find((s) => s.node === tn);
          return seg ? seg.start : null;
        }
      }
      if (offset > 0) {
        const prev = container.childNodes[offset - 1];
        const tn = lastTextNodeInSubtreeForFlat(prev, flat);
        if (tn) {
          const seg = flat.segments.find((s) => s.node === tn);
          return seg ? seg.start + tn.nodeValue.length : null;
        }
      }
    }
    return null;
  }

  function rangeToGlobalOffsets(range, flat) {
    const start = boundaryPointToGlobalOffset(
      range.startContainer,
      range.startOffset,
      flat
    );
    const end = boundaryPointToGlobalOffset(
      range.endContainer,
      range.endOffset,
      flat
    );
    if (start == null || end == null || start > end) {
      return null;
    }
    return { start, end };
  }

  /** Curius `L`: `needle` appears exactly once in `haystack`. */
  function substringOccursOnce(haystack, needle) {
    if (!needle) {
      return false;
    }
    return haystack.split(needle).length - 1 === 1;
  }

  /**
   * Expand around the selection until the window is unique in the page text and
   * there is at least ~15 chars of left/right padding (same idea as Curius `U`).
   */
  function computeCuriusHighlightContexts(fullDoc, selStart, selEnd) {
    const rawLen = selEnd - selStart;
    if (
      rawLen < 1 ||
      selStart < 0 ||
      selEnd > fullDoc.length ||
      selStart > selEnd
    ) {
      return null;
    }
    let leftIdx = selStart;
    let rightIdx = selEnd;
    const PAD = 15;
    function sLen() {
      return selStart - leftIdx;
    }
    function rightPadLen() {
      return rightIdx - selEnd;
    }
    function chunk() {
      return fullDoc.slice(leftIdx, rightIdx);
    }
    function L() {
      return substringOccursOnce(fullDoc, chunk());
    }
    while (true) {
      const needUnique = !L();
      const needLeftPad = sLen() < PAD;
      const needRightPad = rightPadLen() < PAD;
      if (!needUnique && !needLeftPad && !needRightPad) {
        break;
      }
      const canLeft = leftIdx > 0;
      const canRight = rightIdx < fullDoc.length;
      if (!canLeft && !canRight) {
        break;
      }
      let progress = false;
      if (canRight && (needUnique || needRightPad)) {
        rightIdx++;
        progress = true;
      }
      if (canLeft && (needUnique || needLeftPad)) {
        leftIdx--;
        progress = true;
      }
      if (!progress) {
        break;
      }
    }
    const big = fullDoc.slice(leftIdx, rightIdx);
    const sVal = selStart - leftIdx;
    const rawHighlight = fullDoc.slice(selStart, selEnd);
    return {
      rawHighlight: zCurius(rawHighlight),
      highlightText: zCurius(rawHighlight),
      leftContext: zCurius(big.slice(0, sVal)),
      rightContext: zCurius(big.slice(sVal + rawLen)),
    };
  }

  /**
   * Linear text of the article (for context-aware matching). Rebuilt after each
   * mark so offsets stay valid for the next highlight.
   */
  function buildFlatTextMap(root) {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          return acceptHighlightTextNode(node)
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
      if (!val) {
        continue;
      }
      const len = val.length;
      segments.push({ node, start: pos, end: pos + len });
      parts.push(val);
      pos += len;
    }
    return { text: parts.join(""), segments };
  }

  function boundaryFromOffset(flat, pos) {
    if (!flat.segments.length) {
      return null;
    }
    if (pos < 0 || pos > flat.text.length) {
      return null;
    }
    if (pos === flat.text.length) {
      const last = flat.segments[flat.segments.length - 1];
      if (!last) {
        return null;
      }
      return { node: last.node, offset: last.node.nodeValue.length };
    }
    for (let i = 0; i < flat.segments.length; i++) {
      const seg = flat.segments[i];
      if (pos >= seg.start && pos < seg.end) {
        return { node: seg.node, offset: pos - seg.start };
      }
      if (pos === seg.end && i < flat.segments.length - 1) {
        const next = flat.segments[i + 1];
        if (next && pos === next.start) {
          return { node: next.node, offset: 0 };
        }
      }
    }
    return null;
  }

  function wrapRangeAroundHighlight(flat, startChar, endChar, attrs) {
    if (!flat.segments.length || startChar >= endChar) {
      return false;
    }
    const startB = boundaryFromOffset(flat, startChar);
    const endB = boundaryFromOffset(flat, endChar);
    if (!startB || !endB) {
      return false;
    }
    const range = document.createRange();
    range.setStart(startB.node, startB.offset);
    range.setEnd(endB.node, endB.offset);
    const mark = document.createElement("mark");
    mark.className = "calm-curius-hl-server";
    if (attrs && attrs.id) {
      mark.dataset.highlightId = String(attrs.id);
    }
    const displayName =
      attrs && attrs.displayName
        ? attrs.displayName
        : attrs && attrs.user
          ? attrs.user
          : "Someone";
    mark.title = displayName || "Someone";
    applyHighlightMarkAppearance(mark, attrs);
    if (attrs && attrs.personKey) {
      mark.dataset.personKey = String(attrs.personKey);
    }
    try {
      range.surroundContents(mark);
      attachHighlightCallout(mark, attrs);
      return true;
    } catch {
      return false;
    }
  }

  function tryWrapByContextConcat(flat, lc, txt, rc, attrs) {
    const attempts = [];
    if (lc && rc) {
      attempts.push({ full: lc + txt + rc, hlOffset: lc.length });
    } else if (lc) {
      attempts.push({ full: lc + txt, hlOffset: lc.length });
    } else if (rc) {
      attempts.push({ full: txt + rc, hlOffset: 0 });
    }
    for (const { full, hlOffset } of attempts) {
      const idx = flat.text.indexOf(full);
      if (idx !== -1) {
        const a = idx + hlOffset;
        const b = a + txt.length;
        if (wrapRangeAroundHighlight(flat, a, b, attrs)) {
          return true;
        }
      }
    }
    return false;
  }

  function contextMatchesAround(flat, idx, txt, lc, rc) {
    const before = flat.text.slice(0, idx);
    const after = flat.text.slice(idx + txt.length);
    const beforeOk =
      !lc ||
      before.endsWith(lc) ||
      normalizeWs(before).endsWith(normalizeWs(lc));
    const afterOk =
      !rc ||
      after.startsWith(rc) ||
      normalizeWs(after).startsWith(normalizeWs(rc));
    return beforeOk && afterOk;
  }

  function tryWrapByDisambiguatedTxt(flat, txt, lc, rc, attrs) {
    let search = 0;
    while (search <= flat.text.length) {
      const idx = flat.text.indexOf(txt, search);
      if (idx === -1) {
        break;
      }
      if (contextMatchesAround(flat, idx, txt, lc, rc)) {
        if (wrapRangeAroundHighlight(flat, idx, idx + txt.length, attrs)) {
          return true;
        }
      }
      search = idx + 1;
    }
    return false;
  }

  function wrapHighlightWithContext(h) {
    const displayName = highlightUser(h);
    const uo = highlightUserObject(h);
    const personKey =
      (uo && personKeyFromUser(uo)) ||
      displayName ||
      String(highlightId(h) || "");
    const v = visualsForHighlight(h);
    let txt = highlightText(h);
    if (!txt || txt.length < 2) {
      return false;
    }
    if (txt.length > 2000) {
      txt = txt.slice(0, 2000);
    }
    const uidFromNestedUser =
      h.user && typeof h.user === "object" && h.user.id != null
        ? h.user.id
        : null;
    const attrs = {
      id: highlightId(h),
      userId:
        h.userId ??
        h.user_id ??
        uidFromNestedUser ??
        (uo && uo.id != null ? uo.id : null),
      user: displayName,
      displayName,
      personKey,
      comment: highlightCommentText(h),
      markBg: v.markBg,
      markBorder: v.markBorder,
      highlightText: txt,
    };
    const lc = typeof h.leftContext === "string" ? h.leftContext : "";
    const rc = typeof h.rightContext === "string" ? h.rightContext : "";
    if (!lc && !rc) {
      return wrapFirstTextMatch(txt, attrs);
    }
    const flat = buildFlatTextMap(document.body);
    if (!flat.text.length) {
      return false;
    }
    if (tryWrapByContextConcat(flat, lc, txt, rc, attrs)) {
      return true;
    }
    if (tryWrapByDisambiguatedTxt(flat, txt, lc, rc, attrs)) {
      return true;
    }
    return wrapFirstTextMatch(txt, attrs);
  }

  function wrapFirstTextMatch(text, attrs) {
    const t = String(text || "").trim();
    if (t.length < 2) {
      return false;
    }
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.nodeValue || !node.parentElement) {
            return NodeFilter.FILTER_REJECT;
          }
          if (
            node.parentElement.closest(
              `#${DOCK_ID}, #${TOOLBAR_ID}, #${COMMENT_PANEL_ID}, script, style, noscript`
            )
          ) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );
    let node;
    while ((node = walker.nextNode())) {
      const val = node.nodeValue;
      const i = val.indexOf(t);
      if (i === -1) {
        continue;
      }
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + t.length);
      const mark = document.createElement("mark");
      mark.className = "calm-curius-hl-server";
      if (attrs && attrs.id) {
        mark.dataset.highlightId = String(attrs.id);
      }
      const displayName =
        attrs && attrs.displayName
          ? attrs.displayName
          : attrs && attrs.user
            ? attrs.user
            : "Someone";
      mark.title = displayName || "Someone";
      applyHighlightMarkAppearance(mark, attrs);
      if (attrs && attrs.personKey) {
        mark.dataset.personKey = String(attrs.personKey);
      }
      try {
        range.surroundContents(mark);
        attachHighlightCallout(mark, attrs);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  function applyServerHighlights(highlights) {
    clearServerMarks();
    const orphanedComments = [];
    for (const h of highlights) {
      if (!highlightText(h)) {
        continue;
      }
      const placed = wrapHighlightWithContext(h);
      if (!placed && highlightCommentText(h)) {
        orphanedComments.push(h);
      }
    }
    // Create margin comments for highlights whose text couldn't be matched on the page
    for (const h of orphanedComments) {
      const uo = highlightUserObject(h);
      const displayName = highlightUser(h);
      const personKey =
        (uo && personKeyFromUser(uo)) ||
        displayName ||
        String(highlightId(h) || "");
      const v = visualsForHighlight(h);
      const key = makeHlPairKey({ id: highlightId(h) });
      const attrs = {
        id: highlightId(h),
        comment: highlightCommentText(h),
        displayName,
        markBorder: v.markBorder,
        personKey,
      };
      // No outerEl — card will be placed at bottom of existing comments
      createMarginComment(key, attrs, v.markBorder, null);
    }
    scheduleLayoutMarginComments();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scheduleLayoutMarginComments());
    });
  }

  function hideToolbar() {
    if (toolbarEl) {
      toolbarEl.classList.remove("calm-curius-visible");
    }
    pendingSelRange = null;
    pendingSelText = null;
  }

  function positionToolbar(rect) {
    if (!toolbarEl) {
      return;
    }
    const pad = 6;
    let top = rect.bottom + pad;
    let left = rect.left;
    toolbarEl.style.top = `${Math.max(8, top)}px`;
    toolbarEl.style.left = `${Math.min(
      window.innerWidth - 240,
      Math.max(8, left)
    )}px`;
  }

  function getSelectionRect() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) {
      return null;
    }
    const range = sel.getRangeAt(0);
    if (dockEl && dockEl.contains(range.commonAncestorContainer)) {
      return null;
    }
    if (toolbarEl && toolbarEl.contains(range.commonAncestorContainer)) {
      return null;
    }
    if (
      commentPanelEl &&
      commentPanelEl.contains(range.commonAncestorContainer)
    ) {
      return null;
    }
    const text = sel.toString().trim();
    if (text.length < 2) {
      return null;
    }
    return { rect: range.getBoundingClientRect(), text };
  }

  function buildToolbar() {
    const t = document.createElement("div");
    t.id = TOOLBAR_ID;
    t.innerHTML = `
      <div class="calm-curius-sel-actions">
        <button type="button" class="calm-curius-primary" data-action="add">Add highlight</button>
        <button type="button" data-action="cancel">Cancel</button>
      </div>
      <textarea placeholder="Optional comment" maxlength="500" rows="2" data-field="comment"></textarea>
    `;
    t.querySelector('[data-action="cancel"]').addEventListener("click", () => {
      hideToolbar();
      window.getSelection().removeAllRanges();
    });
    t.querySelector('[data-action="add"]').addEventListener("click", () =>
      commitHighlight()
    );
    document.documentElement.appendChild(t);
    return t;
  }

  async function commitHighlight() {
    // Use captured selection — typing in the comment textarea deselects page text
    const range = pendingSelRange;
    const text = pendingSelText || "";
    if (!range || text.length < 2) {
      hideToolbar();
      return;
    }
    const commentInput = toolbarEl.querySelector('[data-field="comment"]');
    const comment = commentInput ? commentInput.value.trim() : "";

    let link = lastLink;
    let linkId = link && link.id != null ? link.id : null;

    // Auto-save the page if not yet saved by the viewer
    if (linkId == null || !isSavedByMe(link)) {
      setStatus("");
      const saveRes = await sendCurius("savePage", {
        url: urlForCuriusApi(location.href),
        title: document.title || "Untitled",
        snippet: pageSnippet(),
        classify: true,
      });
      if (!saveRes?.ok) {
        setStatus("Could not save page.");
        hideToolbar();
        return;
      }
      optimisticSavedByMe = true;
      // Re-fetch link data to get the linkId
      const pageUrl = urlForCuriusApi(location.href);
      const reRes = await sendCurius("getPageLink", { url: pageUrl });
      link = extractLink(reRes);
      if (link) {
        lastLink = link;
      }
      linkId = link && link.id != null ? link.id : null;
    }

    if (linkId == null) {
      setStatus("");
      hideToolbar();
      return;
    }

    const flat = buildFlatTextMap(document.body);
    const offs = rangeToGlobalOffsets(range, flat);
    const ctx =
      offs && computeCuriusHighlightContexts(flat.text, offs.start, offs.end);
    /* Curius rows use `highlight` as the primary quoted-text field (see highlightText(h));
     * POST must include it — server/linkview match on `h.highlight`, not only `text`. */
    const highlightPayload = ctx
      ? {
          highlight: ctx.highlightText,
          text: ctx.highlightText,
          highlightText: ctx.highlightText,
          rawHighlight: ctx.rawHighlight,
          leftContext: ctx.leftContext,
          rightContext: ctx.rightContext,
        }
      : (() => {
          const z = zCurius(text);
          return {
            highlight: z,
            text: z,
            highlightText: z,
            rawHighlight: z,
            leftContext: "",
            rightContext: "",
          };
        })();
    if (comment) {
      highlightPayload.comment = comment;
    }

    setStatus("");
    const res = await sendCurius("addHighlight", {
      linkId,
      highlight: highlightPayload,
    });
    curiusDbg("commitHighlight addHighlight response", {
      ok: res?.ok,
      status: res?.status,
      commentSaved: res?.commentSaved,
      commentError: res?.commentError,
      dataKeys:
        res?.data && typeof res.data === "object"
          ? Object.keys(res.data)
          : null,
    });
    if (res?.disabled) {
      setStatus("");
      hideToolbar();
      return;
    }
    if (!res?.ok) {
      const d = res?.data;
      let apiMsg = "";
      if (d && typeof d === "object") {
        apiMsg = String(d.message || d.error || "").trim();
        if (!apiMsg && d.errors && typeof d.errors === "object") {
          apiMsg = Object.values(d.errors)
            .flat()
            .filter((x) => typeof x === "string")
            .join(" ");
        }
      }
      const extra =
        apiMsg
          ? ` ${apiMsg}`
          : res?.status
            ? ` (${res.status})`
            : res?.error
              ? ` (${String(res.error)})`
              : "";
      setStatus(`Could not save highlight.${extra}`);
      hideToolbar();
      return;
    }

    try {
      const vm = visualsForMe();
      const mark = document.createElement("mark");
      mark.className = "calm-curius-hl-mine";
      const meName = currentUserProfile
        ? userLabel(currentUserProfile)
        : "You";
      mark.title = meName || "You";
      applyHighlightMarkAppearance(mark, {
        markBg: vm.markBg,
        markBorder: vm.markBorder,
      });
      const meKey =
        currentUserProfile &&
        (personKeyFromUser(currentUserProfile) || userLabel(currentUserProfile));
      mark.dataset.personKey = meKey || "me";
      range.surroundContents(mark);
      attachHighlightCallout(mark, {
        comment,
        displayName: meName,
        markBorder: vm.markBorder,
        personKey: meKey || "me",
        isMine: true,
        highlightText: text,
        userId: currentUserId,
      });
    } catch {
      /* cross-node selection: API saved; on-page mark skipped */
    }

    window.getSelection()?.removeAllRanges();
    pendingSelRange = null;
    pendingSelText = null;
    hideToolbar();
    setStatus("");
    // Don't refresh immediately — the local render already shows the highlight + comment.
    // The server may not have indexed the comment yet; next page load will sync.
    if (comment && res.commentSaved === false) {
      setStatus(
        res.commentError
          ? `Highlight saved; comment not saved (${res.commentError}).`
          : "Highlight saved; comment could not be saved."
      );
    }
  }

  function onMouseUp(ev) {
    if (!dockEl || !toolbarEl) {
      return;
    }
    const t = ev.target;
    if (dockEl.contains(t) || toolbarEl.contains(t)) {
      return;
    }
    window.setTimeout(() => {
      if (!lastLink || lastLink.id == null || !isSavedByMe(lastLink)) {
        hideToolbar();
        return;
      }
      const got = getSelectionRect();
      if (!got) {
        hideToolbar();
        return;
      }
      // Capture selection now — clicking the comment textarea will deselect page text
      const sel = window.getSelection();
      pendingSelRange = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      pendingSelText = sel ? sel.toString().trim() : "";
      toolbarEl.querySelector('[data-field="comment"]').value = "";
      toolbarEl.classList.add("calm-curius-visible");
      positionToolbar(got.rect);
    }, 0);
  }

  function onWindowScrollResize() {
    hideToolbar();
  }

  function highlightMarkFromClickTarget(t) {
    if (!t || typeof t.closest !== "function") {
      return null;
    }
    const direct = t.closest(
      "mark.calm-curius-hl-server, mark.calm-curius-hl-mine"
    );
    if (direct) {
      return direct;
    }
    const outer = t.closest(".calm-curius-hl-outer");
    if (outer) {
      return outer.querySelector(
        "mark.calm-curius-hl-server, mark.calm-curius-hl-mine"
      );
    }
    return null;
  }

  function copyTextFallback(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      document.body.removeChild(ta);
    }
  }

  async function copyHighlightTextToClipboard(mark) {
    const raw = mark && mark.textContent ? mark.textContent : "";
    const text = normalizeWs(raw);
    if (!text) {
      return;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch {
      /* fall through */
    }
    copyTextFallback(text);
  }

  function onHighlightClick(ev) {
    if (!dockEl) {
      return;
    }
    const t = ev.target;
    if (dockEl.contains(t) || (toolbarEl && toolbarEl.contains(t))) {
      return;
    }
    if (commentPanelEl && commentPanelEl.contains(t)) {
      return;
    }
    const mark = highlightMarkFromClickTarget(t);
    if (!mark) {
      return;
    }
    void copyHighlightTextToClipboard(mark);
  }

  function setStatus(msg) {
    const t = dockEl && dockEl.querySelector(".calm-curius-dock-toast");
    if (!t) {
      return;
    }
    if (!msg) {
      t.hidden = true;
      t.textContent = "";
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
      return;
    }
    t.textContent = msg;
    t.hidden = false;
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(() => {
      t.hidden = true;
      t.textContent = "";
      toastTimer = null;
    }, 3200);
  }

  function renderDockUsers(users) {
    if (!dockEl) {
      return;
    }
    const av = dockEl.querySelector(".calm-curius-dock-avatars");
    if (!av) {
      return;
    }
    av.innerHTML = "";
    /* Badge = highlights per person on this link (not only rows with comment text).
     * API often returns comment: null even when a highlight exists; POST /links/url also
     * omits link.users, so we key by personKeyForHighlightComment (userId + h.user). */
    const commentCounts = new Map();
    const highlights = lastLink ? extractHighlights(lastLink) : [];
    for (const h of highlights) {
      const pk = personKeyForHighlightComment(h);
      if (!pk) continue;
      commentCounts.set(pk, (commentCounts.get(pk) || 0) + 1);
    }
    // Sort: more highlights on this page first
    const sorted = [...users].sort((a, b) => {
      const ka = personKeyFromUser(a) || userLabel(a);
      const kb = personKeyFromUser(b) || userLabel(b);
      return (commentCounts.get(kb) || 0) - (commentCounts.get(ka) || 0);
    });
    for (const u of sorted) {
      const name = userLabel(u);
      const key = personKeyFromUser(u) || name;
      const v = personVisuals(key);
      const letter = escapeHtml(avatarInitial(u));
      const span = document.createElement("span");
      span.className = "calm-curius-avatar";
      span.dataset.personKey = key;
      span.style.background = v.avatarBg;
      span.dataset.name = name;
      span.setAttribute("role", "button");
      span.setAttribute("tabindex", "0");
      span.innerHTML = letter;
      const count = commentCounts.get(key) || 0;
      if (count > 0) {
        const badge = document.createElement("span");
        badge.className = "calm-curius-avatar-badge";
        badge.textContent = count > 9 ? "9+" : String(count);
        span.appendChild(badge);
      }
      av.appendChild(span);
    }
    syncDockAvatarSelection();
    const toggle = dockEl.querySelector(".calm-curius-dock-toggle");
    if (toggle) {
      toggle.hidden = users.length === 0;
    }
  }

  function renderFromLink(link, meta) {
    lastLink = link;

    if (!link || link.id == null) {
      setStatus(meta ? meta : "");
      renderDockUsers([]);
      clearServerMarks();
      return;
    }

    const users = buildSaversList(link, currentUserProfile);
    const highlights = extractHighlights(link);
    renderDockUsers(users);
    applyServerHighlights(highlights);

    setStatus(meta ? meta : "");
  }

  async function refreshLinkData() {
    setStatus("");
    const pageUrl = urlForCuriusApi(location.href);
    const [res, userRes, netRes] = await Promise.all([
      sendCurius("getPageLink", { url: pageUrl }),
      sendCurius("getUser"),
      sendCurius("getPageNetwork", { url: pageUrl }),
    ]);
    const u = extractCuriusUserObject(userRes?.data);
    currentUserProfile = u && typeof u === "object" ? u : null;
    currentUserId =
      u && u.id != null ? u.id : u && u.uid != null ? u.uid : null;

    if (res?.disabled) {
      removeCuriusUi();
      return;
    }
    if (!res?.ok) {
      optimisticSavedByMe = false;
      if (res?.status === 401 || res?.status === 403) {
        renderFromLink(null, "Not logged in.");
      } else {
        renderFromLink(null, "Could not load page data.");
      }
      return;
    }
    let link = extractLink(res);
    if (netRes?.ok) {
      const net = extractNetworkInfo(netRes);
      link = mergeLinkWithNetwork(link, net, netRes.data);
    }
    if (link && link.id != null) {
      const lv = await sendCurius("getLinkView", { linkId: link.id });
      if (lv?.ok && lv.data) {
        link = mergeLinkView(link, lv.data);
      }
    }
    if (
      optimisticSavedByMe &&
      link &&
      link.id != null &&
      Object.prototype.hasOwnProperty.call(link, "viewerHasSaved")
    ) {
      optimisticSavedByMe = false;
    }
    renderFromLink(link, "");
  }

  async function savePage() {
    setStatus("");
    const res = await sendCurius("savePage", {
      url: urlForCuriusApi(location.href),
      title: document.title || "Untitled",
      snippet: pageSnippet(),
      classify: true,
    });
    if (res?.disabled) {
      setStatus("");
      return;
    }
    if (!res?.ok) {
      setStatus("Save failed.");
      return;
    }
    optimisticSavedByMe = true;
    setStatus("");
    /* Save response `link.users` is often only the viewer — reload network + linkview
       so “who saved” matches a normal page load (everyone, not replaced by just you). */
    await refreshLinkData();
  }

  /** @returns {Promise<boolean>} */
  async function unsavePage() {
    const linkId = lastLink && lastLink.id;
    if (linkId == null) {
      setStatus("");
      return false;
    }
    setStatus("");
    const res = await sendCurius("unsavePage", { linkId });
    if (res?.disabled) {
      setStatus("");
      return false;
    }
    if (!res?.ok) {
      setStatus("Could not unsave.");
      return false;
    }
    optimisticSavedByMe = false;
    setStatus("");
    await refreshLinkData();
    return true;
  }

  function removeCuriusUi() {
    clearServerMarks();
    clearMineMarks();
    document.removeEventListener("mouseup", onMouseUp, true);
    document.removeEventListener("click", onHighlightClick, true);
    window.removeEventListener("scroll", onWindowScrollResize, true);
    document.removeEventListener("scroll", onWindowScrollResize, true);
    if (document.body) {
      document.body.removeEventListener("scroll", onWindowScrollResize, true);
    }
    window.removeEventListener("resize", onWindowScrollResize);
    if (visualViewportScrollBound && window.visualViewport) {
      window.visualViewport.removeEventListener("scroll", onWindowScrollResize);
      window.visualViewport.removeEventListener("resize", onWindowScrollResize);
      visualViewportScrollBound = false;
    }
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (dockEl) {
      dockEl.remove();
      dockEl = null;
    }
    if (toolbarEl) {
      toolbarEl.remove();
      toolbarEl = null;
    }
    clearMarginComments();
    if (commentPanelEl) {
      commentPanelEl.remove();
      commentPanelEl = null;
    }
    lastLink = null;
    optimisticSavedByMe = false;
    currentUserId = null;
    currentUserProfile = null;
    dockCollapsed = false;
    dockNavPersonKey = null;
    dockNavIndex = -1;
    hlKeySeq = 0;
  }

  function collectMarksForPerson(personKey) {
    const want = String(personKey);
    return Array.from(
      document.querySelectorAll(
        "mark.calm-curius-hl-server[data-person-key], mark.calm-curius-hl-mine[data-person-key]"
      )
    ).filter((el) => el.dataset.personKey === want);
  }

  function scrollTargetForMark(mark) {
    const outer = mark.closest(".calm-curius-hl-outer");
    return outer || mark;
  }

  /** Brief pulse when cycling highlights from the dock (avatar clicks). */
  function pulseHighlightNav(mark) {
    const outer = mark.closest(".calm-curius-hl-outer");
    const el = outer || mark;
    el.classList.remove("calm-curius-hl-nav-pulse");
    void el.offsetWidth;
    el.classList.add("calm-curius-hl-nav-pulse");
    el.addEventListener(
      "animationend",
      () => el.classList.remove("calm-curius-hl-nav-pulse"),
      { once: true }
    );
  }

  function pulseMarginCommentNav(card) {
    if (!card || !card.isConnected) {
      return;
    }
    card.classList.remove("calm-curius-hl-nav-pulse");
    void card.offsetWidth;
    card.classList.add("calm-curius-hl-nav-pulse");
    card.addEventListener(
      "animationend",
      () => card.classList.remove("calm-curius-hl-nav-pulse"),
      { once: true }
    );
  }

  function syncDockAvatarSelection() {
    if (!dockEl) {
      return;
    }
    dockEl.querySelectorAll(".calm-curius-avatar").forEach((span) => {
      const k = span.dataset.personKey;
      span.classList.toggle(
        "calm-curius-avatar--selected",
        dockNavPersonKey != null && k === dockNavPersonKey
      );
    });
  }

  function onDockAvatarClick(personKey) {
    const key = String(personKey);
    const els = collectMarksForPerson(key);
    if (els.length === 0) {
      dockNavPersonKey = key;
      dockNavIndex = -1;
      syncDockAvatarSelection();
      setStatus("");
      return;
    }
    if (dockNavPersonKey !== key) {
      dockNavPersonKey = key;
      dockNavIndex = -1;
      syncDockAvatarSelection();
    }
    dockNavIndex = (dockNavIndex + 1) % els.length;
    const mark = els[dockNavIndex];
    const target = scrollTargetForMark(mark);
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    window.setTimeout(() => pulseHighlightNav(mark), 240);
  }

  function buildDock() {
    const d = document.createElement("div");
    d.id = DOCK_ID;
    d.className = "calm-curius-dock";
    d.innerHTML = `
      <button type="button" class="calm-curius-dock-toggle" aria-expanded="true" aria-label="Collapse">&#8722;</button>
      <div class="calm-curius-dock-avatars"></div>
      <div class="calm-curius-dock-toast" hidden></div>
    `;
    const toggle = d.querySelector(".calm-curius-dock-toggle");
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      dockCollapsed = !dockCollapsed;
      d.classList.toggle("calm-curius-dock--collapsed", dockCollapsed);
      toggle.setAttribute("aria-expanded", dockCollapsed ? "false" : "true");
      toggle.textContent = dockCollapsed ? "+" : "\u2212";
      toggle.setAttribute("aria-label", dockCollapsed ? "Expand" : "Collapse");
    });
    const av = d.querySelector(".calm-curius-dock-avatars");
    av.addEventListener("click", (ev) => {
      const span = ev.target.closest(".calm-curius-avatar");
      if (!span || !av.contains(span)) {
        return;
      }
      const key = span.dataset.personKey;
      if (key == null || key === "") {
        return;
      }
      onDockAvatarClick(key);
    });
    av.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") {
        return;
      }
      const span = ev.target.closest(".calm-curius-avatar");
      if (!span || !av.contains(span)) {
        return;
      }
      const key = span.dataset.personKey;
      if (key == null || key === "") {
        return;
      }
      ev.preventDefault();
      onDockAvatarClick(key);
    });
    document.documentElement.appendChild(d);
    return d;
  }

  async function runIfEnabled() {
    const { curiusEnabled } = await chrome.storage.local.get({
      curiusEnabled: false,
    });
    if (!curiusEnabled) {
      removeCuriusUi();
      return;
    }
    if (!dockEl) {
      dockEl = buildDock();
      toolbarEl = buildToolbar();
      document.addEventListener("mouseup", onMouseUp, true);
      document.addEventListener("click", onHighlightClick, true);
      window.addEventListener("scroll", onWindowScrollResize, true);
      document.addEventListener("scroll", onWindowScrollResize, true);
      if (document.body) {
        document.body.addEventListener("scroll", onWindowScrollResize, true);
      }
      window.addEventListener("resize", onWindowScrollResize);
      if (window.visualViewport && !visualViewportScrollBound) {
        visualViewportScrollBound = true;
        window.visualViewport.addEventListener("scroll", onWindowScrollResize);
        window.visualViewport.addEventListener("resize", onWindowScrollResize);
      }
    }
    await refreshLinkData();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.curiusEnabled) {
      return;
    }
    if (!changes.curiusEnabled.newValue) {
      removeCuriusUi();
    } else {
      runIfEnabled();
    }
  });

  chrome.storage.local.get({ curiusEnabled: false }, (cfg) => {
    if (!cfg.curiusEnabled) {
      return;
    }
    if (document.readyState === "loading") {
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          runIfEnabled();
        },
        { once: true }
      );
    } else {
      runIfEnabled();
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.scope !== "curius") {
      return undefined;
    }
    if (msg.type === "getCuriusSaveState") {
      (async () => {
        try {
          const { curiusEnabled } = await chrome.storage.local.get({
            curiusEnabled: false,
          });
          if (!curiusEnabled) {
            sendResponse({ ok: false, error: "disabled" });
            return;
          }
          if (!dockEl) {
            await runIfEnabled();
          }
          sendResponse({
            ok: true,
            savedByMe: isSavedByMe(lastLink),
          });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }
    if (msg.type === "toggleSavePageFromPopup") {
      (async () => {
        try {
          const { curiusEnabled } = await chrome.storage.local.get({
            curiusEnabled: false,
          });
          if (!curiusEnabled) {
            sendResponse({ ok: false, error: "disabled" });
            return;
          }
          if (!dockEl) {
            await runIfEnabled();
          }
          if (isSavedByMe(lastLink)) {
            const ok = await unsavePage();
            sendResponse(
              ok ? { ok: true } : { ok: false, error: "unsave_failed" }
            );
          } else {
            await savePage();
            sendResponse({ ok: true });
          }
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true;
    }
    return undefined;
  });
})();
