(function () {
  const PAGE_SCRIPT = "spotifyplayback/page-script.js";
  const HOST_ID = "calm-spotify-playback-host";
  const MESSAGE_SOURCE = "calm-spotifyplayback";
  const DEFAULTS = {
    spotifyPlaybackEnabled: true,
    spotifyPlaybackSpeed: 1,
    spotifyPlaybackVisualizerEnabled: false
  };
  const DEBUG = true;
  const MIN_SPEED = 0.25;
  const MAX_SPEED = 4;
  const SPEED_STEP = 0.25;

  let settings = { ...DEFAULTS };
  let pageScriptInjected = false;
  let host;
  let shadow;
  let visualizerHost;
  let visualizerShadow;
  let visualizerStyle;
  let visualizerBlocks = [];
  let placementObserver;
  let placementScheduled = false;
  let warnedMissingShuffle = false;
  let lastAnalysisLogAt = 0;
  let lastAnalysisMode = "";
  let pagePlaybackPlaying = false;
  let captureContext;
  let captureAnalyser;
  let captureSource;
  let captureStream;
  let captureData;
  let captureRaf;
  let captureStarting = false;
  let captureUnavailable = false;
  let lastCaptureLogAt = 0;
  let visualizerDrift = 0;
  let visualizerPulse = 0;
  let visualizerColorBurst = 0;

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
    settings.spotifyPlaybackVisualizerEnabled = Boolean(settings.spotifyPlaybackVisualizerEnabled);
    debugLog("loaded settings", settings);
  }

  function postSettings() {
    debugLog("posting settings", {
      enabled: settings.spotifyPlaybackEnabled,
      speed: settings.spotifyPlaybackSpeed,
      visualizerPanelEnabled: settings.spotifyPlaybackVisualizerEnabled,
      analysisEnabled: settings.spotifyPlaybackVisualizerEnabled,
      preservePitch: true
    });
    window.postMessage(
      {
        source: MESSAGE_SOURCE,
        type: "settings",
        settings: {
          enabled: settings.spotifyPlaybackEnabled,
          speed: settings.spotifyPlaybackSpeed,
          visualizerEnabled: settings.spotifyPlaybackVisualizerEnabled,
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
    host.style.cssText = [
      "all: initial",
      "position: relative",
      "display: inline-flex",
      "align-items: center",
      "justify-content: center",
      "flex: 0 0 auto",
      "width: 98px",
      "height: 32px",
      "z-index: 2147483647",
      "color-scheme: dark",
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ].join(";");
    shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        width: 98px;
        height: 32px;
        z-index: 2147483647;
        color-scheme: dark;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      button {
        appearance: none;
        margin: 0;
        border: 0;
        background: transparent;
        color: #b3b3b3;
        cursor: pointer;
        font-family: inherit;
      }

      .speed-btn {
        width: 62px;
        height: 32px;
        padding: 0 20px 0 8px;
        display: inline-flex;
        align-items: center;
        justify-content: flex-start;
        border-radius: 7px;
        font: 800 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
      }

      .speed-wrap {
        position: relative;
        width: 62px;
        height: 32px;
        display: inline-flex;
        align-items: center;
      }

      .speed-wrap::after {
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

      .speed-btn:hover,
      .speed-btn:focus,
      .speed-btn[aria-expanded="true"] {
        color: #1ed760;
        outline: none;
      }

      .speed-wrap:has(.speed-btn:hover)::after,
      .speed-wrap:has(.speed-btn:focus)::after,
      .speed-wrap:has(.speed-btn[aria-expanded="true"])::after {
        color: #1ed760;
      }

      .speed-menu {
        position: absolute;
        left: 0;
        bottom: 36px;
        z-index: 1;
        width: 72px;
        max-height: 220px;
        padding: 4px;
        display: grid;
        gap: 2px;
        overflow: auto;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 8px;
        background: #181818;
        box-shadow: 0 16px 32px rgba(0, 0, 0, 0.45);
      }

      .speed-menu[hidden] {
        display: none;
      }

      .speed-option {
        width: 100%;
        height: 26px;
        padding: 0 8px;
        border-radius: 6px;
        text-align: left;
        font: 750 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .speed-option:hover,
      .speed-option[data-active="true"] {
        background: #1ed760;
        color: #07140b;
      }

      .controls {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        width: 98px;
        height: 32px;
      }

      .vis-btn {
        appearance: none;
        width: 32px;
        height: 32px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 0;
        border-radius: 999px;
        background: transparent;
        color: #b3b3b3;
        cursor: pointer;
        font: 800 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing: 0;
      }

      .vis-btn:hover,
      .vis-btn[data-active="true"] {
        color: #1ed760;
      }
    `;

    const controls = document.createElement("span");
    controls.className = "controls";
    const wrap = document.createElement("span");
    wrap.className = "speed-wrap";
    const speedButton = document.createElement("button");
    speedButton.type = "button";
    speedButton.className = "speed-btn";
    speedButton.title = "Spotify playback speed";
    speedButton.setAttribute("aria-label", "Spotify playback speed");
    speedButton.setAttribute("aria-haspopup", "listbox");
    speedButton.setAttribute("aria-expanded", "false");
    const menu = document.createElement("div");
    menu.className = "speed-menu";
    menu.setAttribute("role", "listbox");
    menu.hidden = true;
    getSpeedOptions().forEach((speed) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "speed-option";
      option.dataset.speed = String(speed);
      option.textContent = formatSpeed(speed);
      option.setAttribute("role", "option");
      option.addEventListener("click", () => {
        menu.hidden = true;
        speedButton.setAttribute("aria-expanded", "false");
        debugLog("speed dropdown changed", {
          currentSpeed: settings.spotifyPlaybackSpeed,
          nextSpeed: option.dataset.speed
        });
        void setSpeed(option.dataset.speed);
      });
      menu.appendChild(option);
    });
    speedButton.addEventListener("click", () => {
      menu.hidden = !menu.hidden;
      speedButton.setAttribute("aria-expanded", String(!menu.hidden));
    });
    wrap.append(speedButton, menu);

    const visualizerButton = document.createElement("button");
    visualizerButton.type = "button";
    visualizerButton.className = "vis-btn";
    visualizerButton.title = "Toggle visualizer";
    visualizerButton.setAttribute("aria-label", "Toggle visualizer");
    visualizerButton.textContent = "vis";
    visualizerButton.addEventListener("click", () => {
      const nextEnabled = !settings.spotifyPlaybackVisualizerEnabled;
      debugLog("visualizer button clicked", {
        nextEnabled
      });
      void setVisualizerEnabled(nextEnabled, { userGesture: true });
    });

    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          menu.hidden = true;
          speedButton.setAttribute("aria-expanded", "false");
        }
      },
      true
    );

    document.addEventListener(
      "click",
      (event) => {
        if (host && !event.composedPath().includes(host)) {
          menu.hidden = true;
          speedButton.setAttribute("aria-expanded", "false");
        }
      },
      true
    );

    controls.append(wrap, visualizerButton);
    shadow.append(style, controls);
    shadow.update = function update() {
      const currentSpeed = normalizeSpeed(settings.spotifyPlaybackSpeed);
      speedButton.textContent = formatSpeed(currentSpeed);
      shadow.querySelectorAll(".speed-option").forEach((option) => {
        const isActive = Math.abs(Number(option.dataset.speed) - currentSpeed) < 0.001;
        option.dataset.active = String(isActive);
        option.setAttribute("aria-selected", String(isActive));
      });
      visualizerButton.dataset.active = String(settings.spotifyPlaybackVisualizerEnabled);
      visualizerButton.setAttribute("aria-pressed", String(settings.spotifyPlaybackVisualizerEnabled));
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
      placeVisualizer();
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
      removeVisualizer();
      return;
    }

    if (settings.spotifyPlaybackVisualizerEnabled) {
      ensureVisualizer();
      void startTabCaptureAnalysis();
    } else {
      removeVisualizer();
    }
    if (!host) {
      createUi();
      startPlacementObserver();
      return;
    }

    shadow.update();
    placeUi();
    placeVisualizer();
    startPlacementObserver();
  }

  function getNowPlayingSidebar() {
    return document.getElementById("Desktop_PanelContainer_Id");
  }

  function ensureVisualizerPageStyle() {
    if (visualizerStyle) {
      return;
    }

    visualizerStyle = document.createElement("style");
    visualizerStyle.id = "calm-spotify-visualizer-style";
    visualizerStyle.textContent = `
      #Desktop_PanelContainer_Id[data-calm-spotify-visualizer="true"] {
        display: flex !important;
        flex-direction: column !important;
        overflow: hidden !important;
        padding: 0 !important;
        box-sizing: border-box !important;
      }

      #Desktop_PanelContainer_Id[data-calm-spotify-visualizer="true"] > :not(#calm-spotify-visualizer-host) {
        display: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(visualizerStyle);
  }

  function placeVisualizer() {
    if (!settings.spotifyPlaybackEnabled || !settings.spotifyPlaybackVisualizerEnabled || !visualizerHost) {
      return false;
    }

    const sidebar = getNowPlayingSidebar();
    if (!sidebar) {
      return false;
    }

    ensureVisualizerPageStyle();
    sidebar.dataset.calmSpotifyVisualizer = "true";
    if (visualizerHost.parentElement !== sidebar) {
      sidebar.appendChild(visualizerHost);
      debugLog("inserted visualizer into Now Playing sidebar");
    }

    return true;
  }

  function ensureVisualizer() {
    if (visualizerHost) {
      updateVisualizerState([], 0, 0, 0);
      placeVisualizer();
      return;
    }

    visualizerHost = document.createElement("div");
    visualizerHost.id = "calm-spotify-visualizer-host";
    visualizerHost.style.cssText = [
      "all: initial",
      "display: block",
      "flex: 1 1 auto",
      "width: 100%",
      "height: 100%",
      "min-height: 100%",
      "pointer-events: none",
      "contain: layout style paint",
      "overflow: hidden"
    ].join(";");
    visualizerShadow = visualizerHost.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host {
        display: block;
        width: 100%;
        height: 100%;
        min-height: 100%;
        pointer-events: none;
      }

      .panel {
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        min-height: 100%;
        padding: 12px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 8px;
        background:
          radial-gradient(circle at 35% 15%, rgba(255, 70, 210, 0.24), transparent 34%),
          radial-gradient(circle at 76% 76%, rgba(30, 215, 96, 0.18), transparent 36%),
          linear-gradient(180deg, #050912 0%, #08000f 100%);
        opacity: 0;
        transform: none;
        transition:
          opacity 120ms ease;
      }

      .panel[data-active="true"] {
        opacity: 1;
      }

      canvas {
        display: block;
        width: 100%;
        height: 100%;
        border-radius: 6px;
        background: #050912;
      }
    `;

    const panel = document.createElement("div");
    panel.className = "panel";
    const canvas = document.createElement("canvas");
    panel.appendChild(canvas);
    visualizerShadow.append(style, panel);
    placeVisualizer();
    updateVisualizerState([], 0, 0, 0);
  }

  function removeVisualizer() {
    stopTabCaptureAnalysis();
    const sidebar = getNowPlayingSidebar();
    if (sidebar?.dataset.calmSpotifyVisualizer) {
      delete sidebar.dataset.calmSpotifyVisualizer;
    }
    if (visualizerHost) {
      visualizerHost.remove();
      visualizerHost = undefined;
      visualizerShadow = undefined;
    }
  }

  function getVisualizerSamples(samples) {
    if (Array.isArray(samples) && samples.length) {
      return samples.map((value) => Math.max(0, Math.min(1, Number(value) || 0)));
    }

    return [];
  }

  function clearVisualizer(canvas, mode = "paused") {
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.floor(rect.width * scale));
    const height = Math.max(1, Math.floor(rect.height * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    ctx.lineWidth = Math.max(1, scale);
    ctx.strokeRect(12 * scale, 12 * scale, width - 24 * scale, height - 24 * scale);
    ctx.beginPath();
    ctx.moveTo(width * 0.32, height * 0.5);
    ctx.lineTo(width * 0.5, height * 0.28);
    ctx.lineTo(width * 0.68, height * 0.5);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 255, 255, 0.46)";
    ctx.font = `${11 * scale}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.fillText(mode === "unavailable" ? "audio unavailable" : "paused", 18 * scale, 30 * scale);
    visualizerBlocks = [];
    visualizerColorBurst = 0;
  }

  function drawVisualizer(canvas, samples, energy, bass, treble, mode) {
    const data = getVisualizerSamples(samples);
    if (mode !== "analyser" || !data.length) {
      clearVisualizer(canvas, mode);
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.floor(rect.width * scale));
    const height = Math.max(1, Math.floor(rect.height * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const t = performance.now() / 1000;
    const safeEnergy = Math.max(0, Math.min(1, Number(energy) || 0));
    const safeBass = Math.max(0, Math.min(1, Number(bass) || 0));
    const safeTreble = Math.max(0, Math.min(1, Number(treble) || 0));
    const hue = (t * 34 + safeTreble * 180) % 360;
    const cx = width / 2;
    const cy = height / 2;

    ctx.globalCompositeOperation = "source-over";
    const bg = ctx.createRadialGradient(
      cx + Math.sin(t * 0.7) * width * 0.22,
      cy + Math.cos(t * 0.6) * height * 0.2,
      0,
      cx,
      cy,
      Math.max(width, height) * 0.74
    );
    bg.addColorStop(0, `hsl(${hue}, 95%, ${18 + safeEnergy * 18}%)`);
    bg.addColorStop(0.42, `hsl(${(hue + 95) % 360}, 88%, 10%)`);
    bg.addColorStop(1, "#02030a");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = Math.max(1, 1.1 * scale);
    for (let ring = 0; ring < 7; ring += 1) {
      const radius = (ring + 1) * Math.min(width, height) * 0.075 + safeBass * 58 * scale;
      ctx.strokeStyle = `hsla(${(hue + ring * 34) % 360}, 100%, 62%, ${0.12 + safeBass * 0.14})`;
      ctx.beginPath();
      ctx.arc(
        cx + Math.sin(t * 0.9 + ring) * 16 * scale,
        cy + Math.cos(t * 0.8 + ring) * 14 * scale,
        radius,
        0,
        Math.PI * 2
      );
      ctx.stroke();
    }

    const drawRibbon = (offsetY, flip) => {
      const baseY = cy + offsetY;
      ctx.lineWidth = Math.max(2, 2.4 * scale);
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, `hsla(${hue}, 100%, 62%, 0.85)`);
      gradient.addColorStop(0.48, `hsla(${(hue + 110) % 360}, 100%, 66%, 0.95)`);
      gradient.addColorStop(1, `hsla(${(hue + 220) % 360}, 100%, 64%, 0.85)`);
      ctx.strokeStyle = gradient;
      ctx.beginPath();
      data.forEach((value, index) => {
        const x = (index / Math.max(1, data.length - 1)) * width;
        const warp = Math.sin(t * 2.2 + index * 0.34) * (10 + safeTreble * 22) * scale;
        const amp = value * (height * 0.24 + safeBass * height * 0.08);
        const y = baseY + (flip ? -amp : amp) + warp;
        if (index === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
    };

    drawRibbon(-height * 0.11, false);
    drawRibbon(height * 0.11, true);

    const columns = 10;
    const blockSize = Math.max(14, Math.floor(width / columns));
    if ((visualizerBlocks.length < 14 && safeEnergy > 0.04) || safeBass > 0.58) {
      const count = safeBass > 0.58 ? 3 : 1;
      for (let i = 0; i < count; i += 1) {
        visualizerBlocks.push({
          x: Math.floor(Math.random() * columns) * blockSize,
          y: -blockSize * (1 + Math.random() * 5),
          size: blockSize,
          speed: (0.5 + Math.random() * 1.7 + safeEnergy * 2.2) * scale,
          hue: (hue + Math.random() * 150) % 360,
          shape: Math.floor(Math.random() * 5)
        });
      }
    }

    visualizerBlocks = visualizerBlocks.filter((block) => block.y < height + block.size * 4).slice(-70);
    for (const block of visualizerBlocks) {
      block.y += block.speed * (1 + safeBass * 2.2);
      const cells = [
        [[0, 0], [1, 0], [0, 1], [1, 1]],
        [[0, 0], [0, 1], [0, 2], [0, 3]],
        [[0, 0], [1, 0], [2, 0], [1, 1]],
        [[0, 0], [1, 0], [1, 1], [2, 1]],
        [[1, 0], [2, 0], [0, 1], [1, 1]]
      ][block.shape];
      ctx.fillStyle = `hsla(${block.hue}, 100%, 58%, ${0.2 + safeEnergy * 0.38})`;
      ctx.strokeStyle = `hsla(${(block.hue + 50) % 360}, 100%, 78%, ${0.22 + safeTreble * 0.28})`;
      ctx.lineWidth = Math.max(1, scale);
      for (const [cellX, cellY] of cells) {
        const x = block.x + cellX * block.size * 0.46;
        const y = block.y + cellY * block.size * 0.46;
        const size = block.size * 0.42;
        ctx.fillRect(x, y, size, size);
        ctx.strokeRect(x, y, size, size);
      }
    }

    ctx.globalCompositeOperation = "screen";
    for (let index = 0; index < data.length; index += 3) {
      const value = data[index];
      const angle = (index / data.length) * Math.PI * 2 + t * 0.38;
      const distance = Math.min(width, height) * (0.12 + value * 0.46);
      const x = cx + Math.cos(angle) * distance;
      const y = cy + Math.sin(angle) * distance;
      const radius = (2 + value * 8 + safeBass * 5) * scale;
      ctx.fillStyle = `hsla(${(hue + index * 9) % 360}, 100%, 70%, ${0.22 + value * 0.34})`;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  function getAverage(data, start, end) {
    let total = 0;
    let count = 0;
    for (let index = start; index < end; index += 1) {
      total += data[index] || 0;
      count += 1;
    }

    return count ? total / count / 255 : 0;
  }

  function getTabAudioStreamId() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { scope: "calm-spotifyplayback", type: "getTabAudioStreamId" },
        (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }
          if (!response?.ok || !response.streamId) {
            reject(new Error(response?.error || "missing tab audio stream id"));
            return;
          }
          resolve(response.streamId);
        }
      );
    });
  }

  function connectCapturedStream(stream, mode) {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error("AudioContext is unavailable");
    }
    if (!stream.getAudioTracks().length) {
      throw new Error(`${mode} stream has no audio track`);
    }

    captureContext = new AudioContextCtor();
    captureStream = stream;
    captureSource = captureContext.createMediaStreamSource(stream);
    captureAnalyser = captureContext.createAnalyser();
    captureAnalyser.fftSize = 512;
    captureAnalyser.smoothingTimeConstant = 0.72;
    captureData = new Uint8Array(captureAnalyser.frequencyBinCount);
    captureSource.connect(captureAnalyser);
    if (mode === "tabCapture") {
      captureSource.connect(captureContext.destination);
    }
    stream.getTracks().forEach((track) => {
      track.addEventListener(
        "ended",
        () => {
          debugLog("captured audio stream ended", { mode, kind: track.kind });
          stopTabCaptureAnalysis();
          if (settings.spotifyPlaybackVisualizerEnabled) {
            updateVisualizerState([], 0, 0, 0, "unavailable");
          }
        },
        { once: true }
      );
    });
    debugLog("tab audio analyser connected", {
      mode,
      audioTracks: stream.getAudioTracks().length,
      videoTracks: stream.getVideoTracks().length,
      bins: captureData.length
    });
    runTabCaptureAnalysis();
  }

  async function getDisplayMediaStream() {
    const capture = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      preferCurrentTab: true,
      selfBrowserSurface: "include",
      systemAudio: "include",
      surfaceSwitching: "exclude"
    });
    return capture;
  }

  async function startTabCaptureAnalysis(options = {}) {
    if (captureAnalyser || captureStarting || !settings.spotifyPlaybackVisualizerEnabled) {
      return;
    }

    captureStarting = true;
    captureUnavailable = false;
    try {
      if (options.userGesture) {
        const stream = await getDisplayMediaStream();
        connectCapturedStream(stream, "displayMedia");
        return;
      }

      const streamId = await getTabAudioStreamId();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: streamId
          }
        },
        video: false
      });
      connectCapturedStream(stream, "tabCapture");
    } catch (error) {
      captureUnavailable = true;
      debugLog("tab audio analyser unavailable", String(error));
      updateVisualizerState([], 0, 0, 0, "unavailable");
    } finally {
      captureStarting = false;
    }
  }

  function stopTabCaptureAnalysis() {
    if (captureRaf) {
      window.cancelAnimationFrame(captureRaf);
      captureRaf = undefined;
    }
    if (captureStream) {
      captureStream.getTracks().forEach((track) => track.stop());
    }
    if (captureContext) {
      void captureContext.close().catch(() => {});
    }
    captureContext = undefined;
    captureAnalyser = undefined;
    captureSource = undefined;
    captureStream = undefined;
    captureData = undefined;
    captureStarting = false;
    captureUnavailable = false;
  }

  function runTabCaptureAnalysis() {
    if (!settings.spotifyPlaybackVisualizerEnabled || !captureAnalyser || !captureData) {
      captureRaf = undefined;
      return;
    }

    if (!pagePlaybackPlaying) {
      updateVisualizerState([], 0, 0, 0, "paused");
      captureRaf = window.requestAnimationFrame(runTabCaptureAnalysis);
      return;
    }

    captureAnalyser.getByteFrequencyData(captureData);
    const length = captureData.length;
    const bass = getAverage(captureData, 0, Math.max(1, Math.floor(length * 0.14)));
    const mid = getAverage(
      captureData,
      Math.floor(length * 0.14),
      Math.max(2, Math.floor(length * 0.55))
    );
    const treble = getAverage(captureData, Math.floor(length * 0.55), length);
    const energy = Math.max(bass, mid * 0.8, treble * 0.65);
    const samples = [];
    const sampleCount = 48;
    for (let index = 0; index < sampleCount; index += 1) {
      const start = Math.floor((index / sampleCount) * length);
      const end = Math.max(start + 1, Math.floor(((index + 1) / sampleCount) * length));
      samples.push(getAverage(captureData, start, end));
    }

    const now = performance.now();
    if (now - lastCaptureLogAt > 3000) {
      lastCaptureLogAt = now;
      debugLog("tab audio analysis frame", {
        playing: pagePlaybackPlaying,
        bass,
        mid,
        treble,
        energy,
        sampleMax: Math.max(...samples)
      });
    }

    updateVisualizerState(samples, energy, bass, treble, "analyser");
    captureRaf = window.requestAnimationFrame(runTabCaptureAnalysis);
  }

  function updateVisualizerState(samples, energy, bass, treble, mode = "paused") {
    if (!visualizerShadow) {
      return;
    }

    const active = settings.spotifyPlaybackEnabled && settings.spotifyPlaybackVisualizerEnabled;
    const panel = visualizerShadow.querySelector(".panel");
    const canvas = visualizerShadow.querySelector("canvas");
    if (panel) {
      panel.dataset.active = String(active);
    }
    if (active && canvas) {
      drawVisualizer(canvas, samples, energy, bass, treble, mode);
    }
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

  async function setVisualizerEnabled(enabled, options = {}) {
    settings.spotifyPlaybackVisualizerEnabled = Boolean(enabled);
    if (shadow?.update) {
      shadow.update();
    }
    if (settings.spotifyPlaybackVisualizerEnabled) {
      ensureVisualizer();
      updateVisualizerState([], 0, 0, 0);
      void startTabCaptureAnalysis({ userGesture: Boolean(options.userGesture) });
    } else {
      removeVisualizer();
    }
    await chrome.storage.local.set({
      spotifyPlaybackVisualizerEnabled: settings.spotifyPlaybackVisualizerEnabled
    });
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
    if (changes.spotifyPlaybackVisualizerEnabled) {
      settings.spotifyPlaybackVisualizerEnabled = Boolean(
        changes.spotifyPlaybackVisualizerEnabled.newValue
      );
    }
    if (
      !changes.spotifyPlaybackEnabled &&
      !changes.spotifyPlaybackSpeed &&
      !changes.spotifyPlaybackVisualizerEnabled
    ) {
      return;
    }

    debugLog("storage changed", {
      enabled: settings.spotifyPlaybackEnabled,
      speed: settings.spotifyPlaybackSpeed,
      visualizerEnabled: settings.spotifyPlaybackVisualizerEnabled
    });
    if (settings.spotifyPlaybackEnabled) {
      injectPageScript();
    }
    ensureUi();
    postSettings();
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== MESSAGE_SOURCE) {
      return;
    }

    if (event.data.type === "playback-state") {
      pagePlaybackPlaying = Boolean(event.data.playing);
      debugLog("playback state", {
        playing: pagePlaybackPlaying,
        reason: event.data.reason,
        media: event.data.media
      });
      if (settings.spotifyPlaybackVisualizerEnabled) {
        ensureVisualizer();
        void startTabCaptureAnalysis();
        if (!pagePlaybackPlaying) {
          updateVisualizerState([], 0, 0, 0, "paused");
        } else if (captureUnavailable) {
          updateVisualizerState([], 0, 0, 0, "unavailable");
        }
      }
      return;
    }

    if (event.data.type === "analysis") {
      debugLog("ignoring page-level analysis message", { mode: event.data.mode });
    }
  });

  void init();
})();
