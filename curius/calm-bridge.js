/**
 * Calm Feed — Curius bridge (loaded from uBOL service worker).
 * Handles cookie-authenticated fetches and message routing. No third-party telemetry.
 */

const CURIUS_ORIGIN = "https://curius.app";
/** Also check www — session cookies may be scoped to either host. */
const CURIUS_URLS = ["https://curius.app", "https://www.curius.app"];

/** Set `false` to silence `[Calm Curius bg]` logs (extension service worker console). */
const CURIUS_DEBUG = true;
function curiusDbg(...args) {
  if (!CURIUS_DEBUG) {
    return;
  }
  try {
    console.log("[Calm Curius bg]", ...args);
  } catch (_) {
    /* ignore */
  }
}

/**
 * Curius API expects `Authorization: Bearer <jwt>` (see /api/user). The `jwt` /
 * `token` cookies hold that JWT; sending cookies alone is not enough.
 * For cookie+session flows, Laravel axios uses XSRF-TOKEN / X-XSRF-TOKEN on writes.
 */
function jwtBearerFromCookies(cookies) {
  const jwt = cookies.find((c) => c.name === "jwt" && c.value);
  const token = cookies.find((c) => c.name === "token" && c.value);
  const val = (jwt && jwt.value) || (token && token.value) || "";
  return String(val).trim();
}
async function collectCuriusCookies() {
  const byKey = new Map();
  for (const url of CURIUS_URLS) {
    const list = await chrome.cookies.getAll({ url });
    for (const c of list) {
      const key = `${c.domain}|${c.name}|${c.path || "/"}`;
      if (!byKey.has(key)) {
        byKey.set(key, c);
      }
    }
  }
  return [...byKey.values()];
}

function cookieHeaderFromList(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function xsrfHeaderFromCookies(cookies) {
  const xsrf = cookies.find(
    (c) => c.name === "XSRF-TOKEN" || c.name === "xsrf-token"
  );
  if (!xsrf || !xsrf.value) {
    return "";
  }
  try {
    return decodeURIComponent(xsrf.value.replace(/\+/g, " "));
  } catch {
    return xsrf.value;
  }
}

/** Laravel Sanctum: ensure XSRF-TOKEN exists (session-based API writes). JWT Bearer skips this. */
async function ensureXsrfCookiePresent() {
  const cookies = await collectCuriusCookies();
  if (jwtBearerFromCookies(cookies)) {
    return;
  }
  if (xsrfHeaderFromCookies(cookies)) {
    return;
  }
  try {
    await curiusFetch("/sanctum/csrf-cookie", { method: "GET" });
  } catch {
    /* ignore */
  }
}

/** Before POST/PUT/PATCH/DELETE: preflight CSRF if missing (uses cookie-authenticated fetch). */
async function ensureXsrfForWrites() {
  await ensureXsrfCookiePresent();
}

async function curiusFetch(path, init = {}) {
  const method = (init.method || "GET").toUpperCase();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    await ensureXsrfForWrites();
  }
  const cookies = await collectCuriusCookies();
  const cookieHeader = cookieHeaderFromList(cookies);
  const xsrf = xsrfHeaderFromCookies(cookies);
  const bearer = jwtBearerFromCookies(cookies);

  const headers = new Headers(init.headers || {});
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }
  if (!headers.has("Referer")) {
    headers.set("Referer", `${CURIUS_ORIGIN}/`);
  }
  if (!headers.has("X-Requested-With")) {
    headers.set("X-Requested-With", "XMLHttpRequest");
  }
  if (bearer && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${bearer}`);
  }
  if (cookieHeader) {
    headers.set("Cookie", cookieHeader);
  }
  if (xsrf && !headers.has("X-XSRF-TOKEN")) {
    headers.set("X-XSRF-TOKEN", xsrf);
  }
  if (
    init.body &&
    typeof init.body === "string" &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${CURIUS_ORIGIN}${path}`, {
    ...init,
    headers,
    credentials: "omit",
  });
}

/** Same as official extension `updateHighlight`: POST /highlights ignores `comment` on the payload; persist with PUT /highlight/comment. */
function normalizeHighlightText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function highlightIdFromAddResponse(data) {
  if (!data || typeof data !== "object") {
    return null;
  }
  const h = data.highlight;
  if (h && h.id != null) {
    return Number(h.id);
  }
  if (data.highlightId != null) {
    return Number(data.highlightId);
  }
  if (data.id != null) {
    return Number(data.id);
  }
  return null;
}

/**
 * POST /highlights often returns only `{ success: true }` — resolve id from linkview.
 * If multiple rows share the same text, prefer the current user only when that
 * narrows the set; never drop all candidates when API rows omit userId.
 */
/**
 * Linkview returns `link.highlights` as nested arrays of rows; `fullLink.highlights`
 * may be empty or a small viewer subset. Using only `fullLink || link` misses rows
 * when fullLink exists with highlights: [] — comment PUT then never finds highlightId.
 */
function flattenLinkviewHighlights(raw) {
  if (raw == null || !Array.isArray(raw)) {
    return [];
  }
  const flat = raw.flat(Infinity);
  const out = [];
  for (const item of flat) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      out.push(item);
    }
  }
  return out;
}

function mergedHighlightsFromLinkviewBody(raw) {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const a = flattenLinkviewHighlights(raw.link && raw.link.highlights);
  const b = flattenLinkviewHighlights(raw.fullLink && raw.fullLink.highlights);
  const c = flattenLinkviewHighlights(raw.highlights);
  const byId = new Map();
  for (const h of [...a, ...b, ...c]) {
    if (h && h.id != null) {
      byId.set(String(h.id), h);
    }
  }
  return [...byId.values()];
}

function findHighlightIdInList(highlights, highlightText, userId) {
  const want = normalizeHighlightText(highlightText);
  if (!want) {
    return null;
  }
  let candidates = highlights.filter((h) => {
    const t = normalizeHighlightText(
      h.highlight || h.highlightText || h.rawHighlight || ""
    );
    return t === want;
  });
  if (userId != null && candidates.length > 1) {
    const filtered = candidates.filter(
      (h) => h.userId != null && String(h.userId) === String(userId)
    );
    if (filtered.length > 0) {
      candidates = filtered;
    }
  }
  if (candidates.length === 0) {
    curiusDbg("findHighlightIdInList", {
      want: want.slice(0, 200),
      wantLen: want.length,
      listLen: highlights.length,
      candidates: 0,
      sampleRows: highlights.slice(0, 3).map((h) => ({
        id: h.id,
        t: normalizeHighlightText(
          h.highlight || h.highlightText || h.rawHighlight || ""
        ).slice(0, 120),
      })),
    });
    return null;
  }
  candidates.sort(
    (a, b) =>
      new Date(b.createdDate || 0) - new Date(a.createdDate || 0)
  );
  const id = candidates[0].id != null ? Number(candidates[0].id) : null;
  curiusDbg("findHighlightIdInList", {
    want: want.slice(0, 200),
    candidates: candidates.length,
    pickedId: id,
  });
  return id;
}

async function resolveHighlightIdAfterCreate(linkId, highlightText, userId, data) {
  const fromPost = highlightIdFromAddResponse(data);
  if (fromPost != null) {
    curiusDbg("resolveHighlightIdAfterCreate", {
      linkId,
      fromPost,
      postDataKeys: data && typeof data === "object" ? Object.keys(data) : null,
    });
    return fromPost;
  }
  const want = normalizeHighlightText(highlightText);
  if (!want) {
    curiusDbg("resolveHighlightIdAfterCreate", {
      linkId,
      emptyWant: true,
      rawHtLen: String(highlightText || "").length,
    });
    return null;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 80 * attempt));
    }
    const res = await curiusFetch(
      `/api/linkview/${encodeURIComponent(String(linkId))}`,
      { method: "GET" }
    );
    const raw = await res.json().catch(() => null);
    const highlights = mergedHighlightsFromLinkviewBody(raw);
    const id = findHighlightIdInList(highlights, highlightText, userId);
    curiusDbg("resolveHighlightIdAfterCreate", {
      linkId,
      attempt,
      linkviewOk: res.ok,
      linkviewStatus: res.status,
      mergedCount: highlights.length,
      fromLinkview: {
        link: flattenLinkviewHighlights(raw?.link?.highlights).length,
        fullLink: flattenLinkviewHighlights(raw?.fullLink?.highlights).length,
        top: flattenLinkviewHighlights(raw?.highlights).length,
      },
      want: want.slice(0, 160),
      resolvedId: id,
    });
    if (id != null) {
      return id;
    }
  }
  curiusDbg("resolveHighlightIdAfterCreate", {
    linkId,
    failed: true,
    afterAttempts: 5,
  });
  return null;
}

async function isCuriusFeatureEnabled() {
  const { curiusEnabled } = await chrome.storage.local.get({
    curiusEnabled: false,
  });
  return !!curiusEnabled;
}

function cookieToPlain(c) {
  const o = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expirationDate: c.expirationDate,
    storeId: c.storeId,
  };
  if (c.partitionKey != null) {
    o.partitionKey = c.partitionKey;
  }
  return o;
}

function buildCookieSetUrl(c) {
  const domain = c.domain || ".curius.app";
  const host = domain.startsWith(".") ? domain.slice(1) : domain;
  const path = c.path || "/";
  const proto = c.secure === false ? "http" : "https";
  const base = `${proto}://${host}`;
  return path === "/" ? `${base}/` : `${base}${path}`;
}

function sanitizeSameSite(v) {
  if (v == null) {
    return undefined;
  }
  const s = String(v).toLowerCase();
  if (s === "lax" || s === "strict" || s === "no_restriction") {
    return s;
  }
  return undefined;
}

async function setCookieFromPlain(c) {
  const url = buildCookieSetUrl(c);
  const minimal = {
    url,
    name: c.name,
    value: c.value,
    secure: true,
  };
  if (c.expirationDate != null) {
    minimal.expirationDate = c.expirationDate;
  }

  const details = {
    url,
    name: c.name,
    value: c.value,
    secure: c.secure !== false,
  };
  if (c.domain != null) {
    details.domain = c.domain;
  }
  if (c.path != null) {
    details.path = c.path;
  }
  if (c.httpOnly != null) {
    details.httpOnly = c.httpOnly;
  }
  const ss = sanitizeSameSite(c.sameSite);
  if (ss != null) {
    details.sameSite = ss;
  }
  if (c.expirationDate != null) {
    details.expirationDate = c.expirationDate;
  }
  if (c.storeId != null) {
    details.storeId = c.storeId;
  }

  try {
    await chrome.cookies.set(details);
    return;
  } catch {
    /* fall through */
  }
  try {
    await chrome.cookies.set(minimal);
  } catch {
    /* ignore */
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.scope !== "curius") {
    return false;
  }

  (async () => {
    try {
      if (msg.type === "getUser") {
        await ensureXsrfCookiePresent();
        const res = await curiusFetch("/api/user", { method: "GET" });
        const text = await res.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = null;
        }
        sendResponse({ ok: res.ok, status: res.status, data });
        return;
      }

      if (msg.type === "getPageLink") {
        if (!(await isCuriusFeatureEnabled())) {
          sendResponse({ ok: false, disabled: true });
          return;
        }
        const res = await curiusFetch("/api/links/url", {
          method: "POST",
          body: JSON.stringify({ url: msg.url }),
        });
        const data = await res.json().catch(() => null);
        sendResponse({ ok: res.ok, status: res.status, data });
        return;
      }

      if (msg.type === "getPageNetwork") {
        if (!(await isCuriusFeatureEnabled())) {
          sendResponse({ ok: false, disabled: true });
          return;
        }
        const res = await curiusFetch("/api/links/url/network", {
          method: "POST",
          body: JSON.stringify({ url: msg.url }),
        });
        const data = await res.json().catch(() => null);
        sendResponse({ ok: res.ok, status: res.status, data });
        return;
      }

      if (msg.type === "getLinkView") {
        if (!(await isCuriusFeatureEnabled())) {
          sendResponse({ ok: false, disabled: true });
          return;
        }
        const linkId = msg.linkId;
        if (linkId == null || linkId === "") {
          sendResponse({ ok: false, error: "missing_link_id" });
          return;
        }
        const res = await curiusFetch(
          `/api/linkview/${encodeURIComponent(String(linkId))}`,
          { method: "GET" }
        );
        const text = await res.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = null;
        }
        sendResponse({ ok: res.ok, status: res.status, data });
        return;
      }

      if (msg.type === "savePage") {
        if (!(await isCuriusFeatureEnabled())) {
          sendResponse({ ok: false, disabled: true });
          return;
        }
        const body = {
          link: {
            link: msg.url,
            title: msg.title || "Untitled",
            snippet: msg.snippet || "N/A",
            doc: msg.doc ?? null,
            classify: msg.classify !== false,
          },
        };
        const res = await curiusFetch("/api/links", {
          method: "POST",
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => null);
        sendResponse({ ok: res.ok, status: res.status, data });
        return;
      }

      if (msg.type === "unsavePage") {
        if (!(await isCuriusFeatureEnabled())) {
          sendResponse({ ok: false, disabled: true });
          return;
        }
        const linkId = msg.linkId;
        if (linkId == null || linkId === "") {
          sendResponse({ ok: false, error: "missing_link_id" });
          return;
        }
        const res = await curiusFetch(
          `/api/links/${encodeURIComponent(String(linkId))}`,
          { method: "DELETE" }
        );
        const text = await res.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = null;
        }
        sendResponse({ ok: res.ok, status: res.status, data });
        return;
      }

      if (msg.type === "addHighlight") {
        if (!(await isCuriusFeatureEnabled())) {
          sendResponse({ ok: false, disabled: true });
          return;
        }
        const linkId = msg.linkId;
        const raw = msg.highlight || {};
        const commentText =
          typeof raw.comment === "string" ? raw.comment.trim() : "";
        const highlight = { ...raw };
        delete highlight.comment;
        const res = await curiusFetch(
          `/api/links/${encodeURIComponent(String(linkId))}/highlights`,
          {
            method: "POST",
            body: JSON.stringify({ highlight }),
          }
        );
        const data = await res.json().catch(() => null);
        curiusDbg("addHighlight POST", {
          linkId,
          ok: res.ok,
          status: res.status,
          dataKeys: data && typeof data === "object" ? Object.keys(data) : null,
          sentHighlightKeys:
            highlight && typeof highlight === "object"
              ? Object.keys(highlight)
              : null,
          sentHighlightHighlight: highlight.highlight,
          sentHighlightText: highlight.highlightText,
          commentLen: commentText.length,
        });
        let commentSaved;
        let commentError = null;
        if (res.ok && commentText) {
          const userRes = await curiusFetch("/api/user", { method: "GET" });
          const userData = await userRes.json().catch(() => null);
          const me =
            userData?.user?.id != null
              ? userData.user.id
              : userData?.id != null
                ? userData.id
                : null;
          const ht =
            highlight.highlight ||
            highlight.highlightText ||
            highlight.text ||
            highlight.rawHighlight ||
            "";
          const hid = await resolveHighlightIdAfterCreate(
            linkId,
            ht,
            me,
            data
          );
          if (hid == null) {
            commentSaved = false;
            commentError = "could_not_resolve_highlight_id";
          } else {
            const putRes = await curiusFetch(
              `/api/links/${encodeURIComponent(String(linkId))}/highlight/comment`,
              {
                method: "PUT",
                body: JSON.stringify({
                  commentText,
                  highlightId: hid,
                }),
              }
            );
            const putData = await putRes.json().catch(() => null);
            commentSaved = putRes.ok;
            if (!putRes.ok) {
              commentError =
                (putData && (putData.error || putData.message)) ||
                String(putRes.status);
            }
          }
          curiusDbg("addHighlight comment", {
            linkId,
            hid,
            commentSaved,
            commentError,
          });
        }
        sendResponse({
          ok: res.ok,
          status: res.status,
          data,
          commentSaved,
          commentError:
            commentText && commentSaved === false ? commentError : null,
        });
        return;
      }

      if (msg.type === "deleteHighlight") {
        if (!(await isCuriusFeatureEnabled())) {
          sendResponse({ ok: false, disabled: true });
          return;
        }
        const linkId = msg.linkId;
        const highlightText = msg.highlightText;
        if (linkId == null || linkId === "") {
          sendResponse({ ok: false, error: "missing_link_id" });
          return;
        }
        if (highlightText == null || String(highlightText).length === 0) {
          sendResponse({ ok: false, error: "missing_highlight_text" });
          return;
        }
        const res = await curiusFetch(
          `/api/links/${encodeURIComponent(String(linkId))}/highlights`,
          {
            method: "DELETE",
            body: JSON.stringify({ highlightText: String(highlightText) }),
          }
        );
        const data = await res.json().catch(() => null);
        sendResponse({ ok: res.ok, status: res.status, data });
        return;
      }

      if (msg.type === "addComment") {
        if (!(await isCuriusFeatureEnabled())) {
          sendResponse({ ok: false, disabled: true });
          return;
        }
        const res = await curiusFetch("/api/comments", {
          method: "POST",
          body: JSON.stringify(msg.body || {}),
        });
        const data = await res.json().catch(() => null);
        sendResponse({ ok: res.ok, status: res.status, data });
        return;
      }

      if (msg.type === "exportCuriusCookies") {
        const cookies = await collectCuriusCookies();
        const plain = cookies.map(cookieToPlain);
        sendResponse({
          ok: true,
          json: JSON.stringify(plain, null, 2),
        });
        return;
      }

      if (msg.type === "importCuriusCookies") {
        try {
          let list = msg.payload;
          if (typeof list === "string") {
            list = JSON.parse(list);
          }
          if (!Array.isArray(list)) {
            sendResponse({ ok: false, error: "expected_json_array" });
            return;
          }
          for (const c of list) {
            try {
              await setCookieFromPlain(c);
            } catch {
              /* skip cookies Chrome refuses to set */
            }
          }
          await ensureXsrfCookiePresent();
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
        return;
      }

      sendResponse({ ok: false, error: "unknown_type" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true;
});
