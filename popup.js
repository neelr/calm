async function getAdblockRulesets() {
  const manifest = chrome.runtime.getManifest();
  return (manifest.declarative_net_request?.rule_resources || [])
    .filter((rule) => rule.enabled === true)
    .map((rule) => rule.id);
}

async function isAdblockEnabled() {
  const expected = await getAdblockRulesets();
  const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
  return expected.length > 0 && expected.every((id) => enabled.includes(id));
}

async function getSettings() {
  const settings = await chrome.storage.local.get({
    youtubeEnabled: true,
    xEnabled: true,
    videospeedEnabled: true,
    spotifyPlaybackEnabled: true,
    curiusEnabled: false
  });

  settings.adblockEnabled = await isAdblockEnabled();
  return settings;
}

function sendCurius(type, payload = {}) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ scope: "curius", type, ...payload }, resolve);
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
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

function formatCuriusUser(data) {
  const u = extractCuriusUserObject(data);
  if (!u || typeof u !== "object") {
    return "";
  }
  const name = [
    u.firstName || u.first_name,
    u.lastName || u.last_name
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (name) {
    return name;
  }
  if (u.displayName || u.display_name) {
    return String(u.displayName || u.display_name);
  }
  if (u.name) {
    return String(u.name);
  }
  if (u.email) {
    return String(u.email);
  }
  if (u.userLink || u.user_link) {
    return `@${u.userLink || u.user_link}`;
  }
  if (u.username) {
    return String(u.username);
  }
  if (u.id != null || u.uid != null) {
    return "Signed in";
  }
  return "";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const CURIUS_SVG_BOOKMARK = `<svg class="curius-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/></svg>`;

const CURIUS_SVG_TRASH = `<svg class="curius-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;

function setCuriusSaveToggleMode(savedByMe) {
  const btn = document.getElementById("curiusSaveToggle");
  if (!btn) {
    return;
  }
  btn.dataset.mode = savedByMe ? "unsave" : "save";
  if (savedByMe) {
    btn.classList.remove("curius-icon-btn--save");
    btn.classList.add("curius-icon-btn--unsave");
    btn.innerHTML = CURIUS_SVG_TRASH;
    btn.title = "Remove from your Curius saves";
    btn.setAttribute("aria-label", btn.title);
  } else {
    btn.classList.remove("curius-icon-btn--unsave");
    btn.classList.add("curius-icon-btn--save");
    btn.innerHTML = CURIUS_SVG_BOOKMARK;
    btn.title = "Save this tab to Curius";
    btn.setAttribute("aria-label", btn.title);
  }
}

async function refreshCuriusSaveToggleUi() {
  const btn = document.getElementById("curiusSaveToggle");
  const curiusEnabledEl = document.getElementById("curiusEnabled");
  if (!btn || !curiusEnabledEl?.checked) {
    if (btn) {
      btn.disabled = true;
    }
    return;
  }
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab?.id) {
    btn.disabled = true;
    return;
  }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, {
      scope: "curius",
      type: "getCuriusSaveState",
    });
    if (res?.ok) {
      setCuriusSaveToggleMode(!!res.savedByMe);
      btn.disabled = false;
    } else if (res?.error === "disabled") {
      btn.disabled = true;
      setCuriusSaveToggleMode(false);
    } else {
      setCuriusSaveToggleMode(false);
      btn.disabled = false;
    }
  } catch {
    btn.disabled = true;
  }
}

const CURIUS_SVG_AUTH_LOGIN = `<svg class="curius-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11 7L9.41 8.59 11 10.17H1v2h10.17l-1.59 1.59L11 15l5-5-5-5zm9 12h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-8v2h8v14z"/></svg>`;

const CURIUS_SVG_AUTH_LOGOUT = `<svg class="curius-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.59L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/></svg>`;

async function refreshCuriusAccountUi() {
  const authBtn = document.getElementById("curiusAuth");
  if (!authBtn) {
    return;
  }
  authBtn.innerHTML = CURIUS_SVG_AUTH_LOGIN;
  authBtn.setAttribute("aria-label", "Log in to Curius");
  authBtn.title = "Log in to Curius";
  const res = await sendCurius("getUser");
  const okUser =
    res?.ok &&
    res.status === 200 &&
    res.data != null &&
    extractCuriusUserObject(res.data) != null;
  const label = okUser ? formatCuriusUser(res.data) : "";
  if (label) {
    authBtn.innerHTML = CURIUS_SVG_AUTH_LOGOUT;
    authBtn.setAttribute("aria-label", "Log out of Curius");
    authBtn.title = "Log out of Curius";
    authBtn.dataset.mode = "logout";
    return;
  }
  if (okUser) {
    authBtn.innerHTML = CURIUS_SVG_AUTH_LOGOUT;
    authBtn.setAttribute("aria-label", "Log out of Curius");
    authBtn.title = "Log out of Curius";
    authBtn.dataset.mode = "logout";
    return;
  }
  authBtn.innerHTML = CURIUS_SVG_AUTH_LOGIN;
  authBtn.setAttribute("aria-label", "Log in to Curius");
  authBtn.title = "Log in to Curius";
  authBtn.dataset.mode = "login";
}

async function logoutCurius() {
  const bases = ["https://curius.app", "https://www.curius.app"];
  for (const base of bases) {
    const cookies = await chrome.cookies.getAll({ url: base });
    for (const c of cookies) {
      const path = c.path && c.path.length ? c.path : "/";
      const url =
        path === "/" ? `${base}/` : `${base.replace(/\/$/, "")}${path}`;
      await chrome.cookies.remove({ url, name: c.name });
    }
  }
}

async function setRulesets(enabled) {
  const ids = await getAdblockRulesets();
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: enabled ? ids : [],
    disableRulesetIds: enabled ? [] : ids
  });
}

async function reloadActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    await chrome.tabs.reload(tab.id);
  }
}

async function init() {
  const settings = await getSettings();
  const youtubeEnabled = document.getElementById("youtubeEnabled");
  const xEnabled = document.getElementById("xEnabled");
  const adblockEnabled = document.getElementById("adblockEnabled");
  const videospeedEnabled = document.getElementById("videospeedEnabled");
  const spotifyPlaybackEnabled = document.getElementById("spotifyPlaybackEnabled");
  const curiusEnabled = document.getElementById("curiusEnabled");
  const curiusAuth = document.getElementById("curiusAuth");

  youtubeEnabled.checked = settings.youtubeEnabled;
  xEnabled.checked = settings.xEnabled;
  adblockEnabled.checked = settings.adblockEnabled;
  videospeedEnabled.checked = settings.videospeedEnabled;
  spotifyPlaybackEnabled.checked = settings.spotifyPlaybackEnabled;
  curiusEnabled.checked = settings.curiusEnabled;
  function syncCuriusToolbar() {
    if (!curiusEnabled.checked) {
      const t = document.getElementById("curiusSaveToggle");
      if (t) {
        t.disabled = true;
      }
      return;
    }
    void refreshCuriusSaveToggleUi();
  }
  syncCuriusToolbar();

  await refreshCuriusAccountUi();

  const curiusTokenModal = document.getElementById("curiusTokenModal");
  const curiusTokenInput = document.getElementById("curiusTokenInput");
  const curiusTokenApply = document.getElementById("curiusTokenApply");
  const curiusTokenCancel = document.getElementById("curiusTokenCancel");
  const curiusOpenSite = document.getElementById("curiusOpenSite");

  function showCuriusTokenModal() {
    curiusTokenModal.removeAttribute("hidden");
    curiusTokenInput.focus();
  }

  function hideCuriusTokenModal() {
    curiusTokenModal.setAttribute("hidden", "");
  }

  if (curiusAuth) {
    curiusAuth.addEventListener("click", async () => {
      if (curiusAuth.dataset.mode === "logout") {
        await logoutCurius();
        await refreshCuriusAccountUi();
        return;
      }
      showCuriusTokenModal();
    });
  }

  curiusTokenCancel.addEventListener("click", () => {
    hideCuriusTokenModal();
  });

  curiusOpenSite.addEventListener("click", () => {
    chrome.tabs.create({ url: "https://curius.app/extension-login" });
  });

  curiusTokenApply.addEventListener("click", async () => {
    const raw = curiusTokenInput.value.trim();
    if (!raw) {
      hideCuriusTokenModal();
      return;
    }
    curiusTokenApply.disabled = true;
    try {
      const res = await sendCurius("importCuriusCookies", { payload: raw });
      if (!res?.ok) {
        const err = res?.error || "Import failed";
        window.alert(
          `Could not import session: ${err}\n\nPaste the full JSON from the curius.app export box.`
        );
        return;
      }
      hideCuriusTokenModal();
      curiusTokenInput.value = "";
      await sleep(150);
      await refreshCuriusAccountUi();
      if (curiusAuth.dataset.mode !== "logout") {
        await sleep(450);
        await refreshCuriusAccountUi();
      }
      if (curiusAuth.dataset.mode !== "logout") {
        window.alert(
          "Cookies were imported, but the server did not return a user. Try Apply again, or log in on curius.app and export again."
        );
      }
    } finally {
      curiusTokenApply.disabled = false;
    }
  });

  youtubeEnabled.addEventListener("change", async () => {
    await chrome.storage.local.set({ youtubeEnabled: youtubeEnabled.checked });
    await reloadActiveTab();
  });

  xEnabled.addEventListener("change", async () => {
    await chrome.storage.local.set({ xEnabled: xEnabled.checked });
    await reloadActiveTab();
  });

  adblockEnabled.addEventListener("change", async () => {
    try {
      await setRulesets(adblockEnabled.checked);
      await chrome.storage.local.set({ adblockEnabled: adblockEnabled.checked });
    } catch (error) {
      console.error("[Calm Feed] Failed to toggle adblock", error);
      adblockEnabled.checked = await isAdblockEnabled();
      return;
    }
    await reloadActiveTab();
  });

  videospeedEnabled.addEventListener("change", async () => {
    await chrome.storage.local.set({ videospeedEnabled: videospeedEnabled.checked });
    await reloadActiveTab();
  });

  spotifyPlaybackEnabled.addEventListener("change", async () => {
    await chrome.storage.local.set({ spotifyPlaybackEnabled: spotifyPlaybackEnabled.checked });
    await reloadActiveTab();
  });

  curiusEnabled.addEventListener("change", async () => {
    syncCuriusToolbar();
    await chrome.storage.local.set({ curiusEnabled: curiusEnabled.checked });
    await reloadActiveTab();
  });

  async function runCuriusSaveToggle() {
    if (!curiusEnabled.checked) {
      window.alert("Turn on Curius (page saves) first.");
      return;
    }
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) {
      return;
    }
    const btn = document.getElementById("curiusSaveToggle");
    if (btn) {
      btn.disabled = true;
    }
    try {
      const res = await chrome.tabs.sendMessage(tab.id, {
        scope: "curius",
        type: "toggleSavePageFromPopup",
      });
      if (res?.ok === false) {
        if (res.error === "disabled") {
          window.alert("Turn on Curius (page saves) first.");
        } else if (res.error === "unsave_failed") {
          window.alert("Could not remove this page from Curius.");
        } else {
          window.alert(res.error || "Request failed.");
        }
      }
    } catch {
      window.alert(
        "Could not reach this tab. Open a normal web page with Curius enabled, or refresh the page."
      );
    } finally {
      await refreshCuriusSaveToggleUi();
    }
  }

  const curiusSaveToggle = document.getElementById("curiusSaveToggle");
  if (curiusSaveToggle) {
    curiusSaveToggle.addEventListener("click", () => {
      void runCuriusSaveToggle();
    });
  }
}

init();
