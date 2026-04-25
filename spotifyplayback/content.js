(function () {
  const PAGE_SCRIPT = "spotifyplayback/page-script.js";
  const HOST_ID = "calm-spotify-playback-host";
  const MESSAGE_SOURCE = "calm-spotifyplayback";
  const DEFAULTS = {
    spotifyPlaybackEnabled: true,
    spotifyPlaybackSpeed: 1
  };
  const DEBUG = true;
  const MIN_SPEED = 0.25;
  const MAX_SPEED = 4;
  const SPEED_STEP = 0.25;

  let settings = { ...DEFAULTS };
  let pageScriptInjected = false;
  let host;
  let shadow;
  let placementObserver;
  let placementScheduled = false;
  let warnedMissingShuffle = false;

  function debugLog(...args) {
    if (DEBUG) {
      console.info("[Calm Spotify][content]", ...args);
    }
  }

  function normalizeSpeed(value) {
    const speed = Number(value);
    if (!Number.isFinite(speed)) {
      return 1;
    }

    const stepped = Math.round(speed / SPEED_STEP) * SPEED_STEP;
    return Math.max(MIN_SPEED, Math.min(MAX_SPEED, Math.round(stepped * 100) / 100));
  }

  function formatSpeed(value) {
    const speed = normalizeSpeed(value);
    return Number.isInteger(speed) ? `${speed}x` : `${speed.toFixed(2).replace(/0$/, "")}x`;
  }

  function getSpeedOptions() {
    const options = [];
    for (let speed = MIN_SPEED; speed <= MAX_SPEED + 0.001; speed += SPEED_STEP) {
      options.push(Math.round(speed * 100) / 100);
    }
    return options;
  }

  async function loadSettings() {
    settings = await chrome.storage.local.get(DEFAULTS);
    settings.spotifyPlaybackEnabled = Boolean(settings.spotifyPlaybackEnabled);
    settings.spotifyPlaybackSpeed = normalizeSpeed(settings.spotifyPlaybackSpeed);
    debugLog("loaded settings", settings);
  }

  function postSettings() {
    debugLog("posting settings", {
      enabled: settings.spotifyPlaybackEnabled,
      speed: settings.spotifyPlaybackSpeed,
      preservePitch: true
    });
    window.postMessage(
      {
        source: MESSAGE_SOURCE,
        type: "settings",
        settings: {
          enabled: settings.spotifyPlaybackEnabled,
          speed: settings.spotifyPlaybackSpeed,
          preservePitch: true
        }
      },
      "*"
    );
  }

  function injectPageScript() {
    if (pageScriptInjected) {
      postSettings();
      return;
    }

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL(PAGE_SCRIPT);
    script.onload = () => {
      debugLog("page script loaded");
      script.remove();
      postSettings();
    };
    script.onerror = () => {
      console.warn("[Calm Spotify][content] failed to load page script", script.src);
    };
    debugLog("injecting page script", script.src);
    (document.documentElement || document.head || document.body).appendChild(script);
    pageScriptInjected = true;
  }

  function createUi() {
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.all = "initial";
    shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        width: 62px;
        height: 32px;
        z-index: 2147483647;
        color-scheme: dark;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      select {
        appearance: none;
        width: 62px;
        height: 32px;
        margin: 0;
        padding: 0 20px 0 8px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: #b3b3b3;
        font: 800 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
        cursor: pointer;
      }

      .select-wrap {
        position: relative;
        width: 62px;
        height: 32px;
        display: inline-flex;
        align-items: center;
      }

      .select-wrap::after {
        content: "";
        position: absolute;
        right: 8px;
        top: 50%;
        width: 0;
        height: 0;
        border-left: 4px solid transparent;
        border-right: 4px solid transparent;
        border-top: 5px solid currentColor;
        color: #b3b3b3;
        transform: translateY(-35%);
        pointer-events: none;
      }

      select:hover,
      select:focus {
        color: #1ed760;
        outline: none;
      }

      .select-wrap:has(select:hover)::after,
      .select-wrap:has(select:focus)::after {
        color: #1ed760;
      }
    `;

    const wrap = document.createElement("span");
    wrap.className = "select-wrap";
    const select = document.createElement("select");
    select.title = "Spotify playback speed";
    select.setAttribute("aria-label", "Spotify playback speed");
    getSpeedOptions().forEach((speed) => {
      const option = document.createElement("option");
      option.value = String(speed);
      option.textContent = formatSpeed(speed);
      select.appendChild(option);
    });
    select.addEventListener("change", () => {
      debugLog("speed dropdown changed", {
        currentSpeed: settings.spotifyPlaybackSpeed,
        nextSpeed: select.value
      });
      void setSpeed(select.value);
    });
    wrap.appendChild(select);

    shadow.append(style, wrap);
    shadow.update = function update() {
      select.value = String(normalizeSpeed(settings.spotifyPlaybackSpeed));
    };

    shadow.update();
    placeUi();
  }

  function findShuffleButton() {
    const selector = [
      'button[data-testid="control-button-shuffle"]',
      'button[aria-label*="shuffle" i]'
    ].join(",");
    const playerRoots = document.querySelectorAll(
      [
        '[data-testid="now-playing-bar"]',
        '[data-testid="player-controls"]',
        "footer"
      ].join(",")
    );

    for (const root of playerRoots) {
      const button = root.querySelector(selector);
      if (button) {
        return button;
      }
    }

    return document.querySelector('button[data-testid="control-button-shuffle"]');
  }

  function placeUi() {
    if (!settings.spotifyPlaybackEnabled || !host) {
      return false;
    }

    const shuffleButton = findShuffleButton();
    if (!shuffleButton?.parentElement) {
      if (!warnedMissingShuffle) {
        warnedMissingShuffle = true;
        console.warn("[Calm Spotify][content] shuffle button not found yet");
      }
      return false;
    }

    warnedMissingShuffle = false;
    if (host.previousElementSibling !== shuffleButton) {
      shuffleButton.insertAdjacentElement("afterend", host);
      debugLog("inserted speed dropdown after shuffle");
    }

    return true;
  }

  function schedulePlacement() {
    if (placementScheduled) {
      return;
    }

    placementScheduled = true;
    window.requestAnimationFrame(() => {
      placementScheduled = false;
      placeUi();
    });
  }

  function startPlacementObserver() {
    if (placementObserver || !document.documentElement) {
      return;
    }

    placementObserver = new MutationObserver(schedulePlacement);
    placementObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function stopPlacementObserver() {
    if (placementObserver) {
      placementObserver.disconnect();
      placementObserver = undefined;
    }
    placementScheduled = false;
  }

  function ensureUi() {
    if (!settings.spotifyPlaybackEnabled) {
      stopPlacementObserver();
      if (host) {
        host.remove();
        host = undefined;
        shadow = undefined;
      }
      return;
    }

    if (!host) {
      createUi();
      startPlacementObserver();
      return;
    }

    shadow.update();
    placeUi();
    startPlacementObserver();
  }

  async function setSpeed(speed) {
    settings.spotifyPlaybackSpeed = normalizeSpeed(speed);
    debugLog("setting speed", settings.spotifyPlaybackSpeed);
    await chrome.storage.local.set({ spotifyPlaybackSpeed: settings.spotifyPlaybackSpeed });
    if (shadow?.update) {
      shadow.update();
    }
    postSettings();
  }

  async function init() {
    await loadSettings();
    if (settings.spotifyPlaybackEnabled) {
      injectPageScript();
    }

    if (document.body) {
      ensureUi();
    } else {
      document.addEventListener("DOMContentLoaded", ensureUi, { once: true });
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    if (changes.spotifyPlaybackEnabled) {
      settings.spotifyPlaybackEnabled = Boolean(changes.spotifyPlaybackEnabled.newValue);
    }
    if (changes.spotifyPlaybackSpeed) {
      settings.spotifyPlaybackSpeed = normalizeSpeed(changes.spotifyPlaybackSpeed.newValue);
    }
    if (!changes.spotifyPlaybackEnabled && !changes.spotifyPlaybackSpeed) {
      return;
    }

    debugLog("storage changed", {
      enabled: settings.spotifyPlaybackEnabled,
      speed: settings.spotifyPlaybackSpeed
    });
    if (settings.spotifyPlaybackEnabled) {
      injectPageScript();
    }
    ensureUi();
    postSettings();
  });

  void init();
})();
