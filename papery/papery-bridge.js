/**
 * Calm Feed — Papery bridge (loaded from the uBOL service worker).
 *
 * Papery is a single-user, token-authenticated reading list. Network calls run
 * here in the service worker rather than the content script for two reasons:
 *   1. a page's CSP `connect-src` can't block a request made from the worker, so
 *      saving works on strict-CSP sites (news sites, GitHub, ...);
 *   2. the access token stays in the background and never enters a page-adjacent
 *      context.
 * Auth is a Bearer token in chrome.storage.local — no cookies, so (unlike the
 * Curius bridge) there is nothing to collect from chrome.cookies.
 */

const PAPERY_DEBUG = false;
function paperyDbg(...args) {
  if (!PAPERY_DEBUG) {
    return;
  }
  try {
    console.log("[Calm Papery bg]", ...args);
  } catch (_) {
    /* ignore */
  }
}

function paperyNormalizeEndpoint(raw) {
  let s = String(raw || "")
    .trim()
    .replace(/\/+$/, "");
  if (s && !/^https?:\/\//i.test(s)) {
    s = `https://${s}`;
  }
  return s;
}

async function paperyGetConfig() {
  const s = await chrome.storage.local.get({
    paperyEnabled: false,
    paperyEndpoint: "",
    paperyToken: "",
  });
  return {
    enabled: !!s.paperyEnabled,
    endpoint: paperyNormalizeEndpoint(s.paperyEndpoint),
    token: String(s.paperyToken || "").trim(),
  };
}

async function paperyFetch(endpoint, token, path, options = {}) {
  const res = await fetch(`${endpoint}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }
  return { status: res.status, ok: res.ok, data };
}

function paperyStatusToError(status) {
  return status === 401 ? "unauthorized" : `http_${status}`;
}

async function paperyHandle(msg) {
  // "validate" carries just-entered credentials that aren't stored yet.
  if (msg.type === "validate") {
    const endpoint = paperyNormalizeEndpoint(msg.endpoint);
    const token = String(msg.token || "").trim();
    if (!endpoint || !token) {
      return { ok: false, error: "missing_fields" };
    }
    try {
      const r = await paperyFetch(
        endpoint,
        token,
        `/api/status?url=${encodeURIComponent("https://example.com/")}`
      );
      return r.ok ? { ok: true } : { ok: false, error: paperyStatusToError(r.status) };
    } catch (_) {
      return { ok: false, error: "unreachable" };
    }
  }

  const cfg = await paperyGetConfig();
  if (!cfg.enabled) {
    return { ok: false, error: "disabled" };
  }
  if (!cfg.endpoint || !cfg.token) {
    return { ok: false, error: "unconfigured" };
  }

  try {
    if (msg.type === "status") {
      const r = await paperyFetch(
        cfg.endpoint,
        cfg.token,
        `/api/status?url=${encodeURIComponent(msg.url || "")}`
      );
      if (!r.ok) {
        return { ok: false, error: paperyStatusToError(r.status) };
      }
      return {
        ok: true,
        saved: !!(r.data && r.data.saved),
        id: r.data && r.data.id != null ? r.data.id : null,
        read: !!(r.data && r.data.read),
        liked: !!(r.data && r.data.liked),
      };
    }

    if (msg.type === "save") {
      const r = await paperyFetch(cfg.endpoint, cfg.token, "/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: msg.url,
          title: msg.title,
          site: msg.site,
          favicon: msg.favicon,
        }),
      });
      if (!r.ok) {
        return { ok: false, error: paperyStatusToError(r.status) };
      }
      return {
        ok: true,
        id: r.data && r.data.id != null ? r.data.id : null,
        saved: true,
        read: !!(r.data && r.data.read),
        liked: !!(r.data && r.data.liked),
      };
    }

    if (msg.type === "toggleLike") {
      const r = await paperyFetch(
        cfg.endpoint,
        cfg.token,
        `/api/toggle-like/${encodeURIComponent(msg.id)}`,
        { method: "POST" }
      );
      if (!r.ok) {
        return { ok: false, error: paperyStatusToError(r.status) };
      }
      return { ok: true, liked: !!(r.data && r.data.liked) };
    }

    if (msg.type === "highlights.list") {
      const r = await paperyFetch(
        cfg.endpoint,
        cfg.token,
        `/api/highlights?url=${encodeURIComponent(msg.url || "")}`
      );
      if (!r.ok) {
        return { ok: false, error: paperyStatusToError(r.status) };
      }
      return {
        ok: true,
        highlights: Array.isArray(r.data && r.data.highlights)
          ? r.data.highlights
          : [],
      };
    }

    if (msg.type === "highlights.add") {
      const r = await paperyFetch(cfg.endpoint, cfg.token, "/api/highlights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: msg.url,
          text: msg.text,
          left: msg.left || "",
          right: msg.right || "",
          comment: msg.comment || "",
        }),
      });
      if (!r.ok) {
        return { ok: false, error: paperyStatusToError(r.status) };
      }
      return { ok: true, id: r.data && r.data.id != null ? r.data.id : null };
    }

    if (msg.type === "highlights.comment") {
      const r = await paperyFetch(
        cfg.endpoint,
        cfg.token,
        `/api/highlights/${encodeURIComponent(msg.id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ comment: msg.comment || "" }),
        }
      );
      if (!r.ok) {
        return { ok: false, error: paperyStatusToError(r.status) };
      }
      return { ok: true };
    }

    if (msg.type === "highlights.remove") {
      const r = await paperyFetch(
        cfg.endpoint,
        cfg.token,
        `/api/highlights/${encodeURIComponent(msg.id)}`,
        { method: "DELETE" }
      );
      if (!r.ok) {
        return { ok: false, error: paperyStatusToError(r.status) };
      }
      return { ok: true };
    }

    if (msg.type === "unsave") {
      const r = await paperyFetch(
        cfg.endpoint,
        cfg.token,
        `/api/paper/${encodeURIComponent(msg.id)}`,
        { method: "DELETE" }
      );
      if (!r.ok) {
        return { ok: false, error: paperyStatusToError(r.status) };
      }
      return { ok: true };
    }
  } catch (_) {
    return { ok: false, error: "unreachable" };
  }

  return { ok: false, error: "unknown_type" };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.scope !== "papery") {
    return false;
  }
  paperyHandle(msg)
    .then((res) => {
      paperyDbg(msg.type, "->", res);
      sendResponse(res);
    })
    .catch((e) => {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    });
  return true; // async sendResponse
});
