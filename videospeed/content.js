(function () {
  const STEP = 0.25;
  const TOGGLE_SPEED = 2;
  const DEFAULT_SPEED = 1;
  const state = new WeakMap();
  const HOST_ID = "calm-videospeed-host";
  let enabled = true;

  async function loadEnabled() {
    try {
      const result = await chrome.storage.local.get({ videospeedEnabled: true });
      enabled = result.videospeedEnabled;
    } catch {
      enabled = true;
    }
  }

  function isEditable(target) {
    if (!target) {
      return false;
    }

    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      return true;
    }

    return Boolean(target.closest('[contenteditable=""], [contenteditable="true"], input, textarea, select'));
  }

  function getVideos() {
    return Array.from(document.querySelectorAll("video")).filter((video) => {
      const rect = video.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  }

  function getTargetVideo() {
    const hovered = document.querySelector("video:hover");
    if (hovered) {
      return hovered;
    }

    const videos = getVideos();
    if (videos.length === 1) {
      return videos[0];
    }

    const playing = videos.find((video) => !video.paused && !video.ended);
    if (playing) {
      return playing;
    }

    return videos[0] || null;
  }

  function clampSpeed(speed) {
    return Math.max(0.25, Math.min(16, Math.round(speed * 100) / 100));
  }

  function getVideoState(video) {
    let value = state.get(video);
    if (!value) {
      value = { previousSpeed: DEFAULT_SPEED, hideTimer: null };
      state.set(video, value);
    }

    return value;
  }

  function ensureBadge() {
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      host.style.all = "initial";
      host.style.position = "fixed";
      host.style.left = "50%";
      host.style.top = "24px";
      host.style.transform = "translateX(-50%)";
      host.style.zIndex = "2147483647";
      host.style.pointerEvents = "none";
      const root = host.attachShadow({ mode: "open" });
      const badge = document.createElement("div");
      badge.id = "badge";
      const style = document.createElement("style");
      style.textContent = `
        #badge {
          box-sizing: border-box;
          padding: 10px 14px;
          border-radius: 999px;
          background: rgba(17, 17, 17, 0.88);
          color: #fff;
          font: 600 18px/1.1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          letter-spacing: 0.02em;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
          opacity: 0;
          transition: opacity 120ms ease;
        }
      `;
      root.append(style, badge);
      const parent = document.body || document.documentElement;
      parent.appendChild(host);
    }

    return host.shadowRoot.getElementById("badge");
  }

  function showBadge(video) {
    const badge = ensureBadge();
    const videoState = getVideoState(video);
    badge.textContent = `${clampSpeed(video.playbackRate || DEFAULT_SPEED)}x`;
    badge.style.opacity = "1";

    if (videoState.hideTimer) {
      clearTimeout(videoState.hideTimer);
    }

    videoState.hideTimer = window.setTimeout(() => {
      badge.style.opacity = "0";
      videoState.hideTimer = null;
    }, 900);
  }

  function setSpeed(video, speed) {
    const next = clampSpeed(speed);
    video.playbackRate = next;
    showBadge(video);
  }

  function toggleSpeed(video) {
    const videoState = getVideoState(video);
    const current = clampSpeed(video.playbackRate || DEFAULT_SPEED);

    if (Math.abs(current - TOGGLE_SPEED) < 0.001) {
      setSpeed(video, videoState.previousSpeed || DEFAULT_SPEED);
      return;
    }

    videoState.previousSpeed = current;
    setSpeed(video, TOGGLE_SPEED);
  }

  function adjustSpeed(video, delta) {
    setSpeed(video, (video.playbackRate || DEFAULT_SPEED) + delta);
  }

  document.addEventListener(
    "ratechange",
    (event) => {
      if (!enabled || !(event.target instanceof HTMLVideoElement)) {
        return;
      }

      showBadge(event.target);
    },
    true
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (!enabled) {
        return;
      }

      if (event.altKey || event.ctrlKey || event.metaKey || isEditable(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key !== "a" && key !== "s" && key !== "d") {
        return;
      }

      const video = getTargetVideo();
      if (!video) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (key === "a") {
        toggleSpeed(video);
        return;
      }

      if (key === "s") {
        adjustSpeed(video, -STEP);
        return;
      }

      adjustSpeed(video, STEP);
    },
    true
  );

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.videospeedEnabled) {
      enabled = changes.videospeedEnabled.newValue;
    }
  });

  void loadEnabled();
})();
