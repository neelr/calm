(function () {
  const MESSAGE_SOURCE = "calm-spotifyplayback";
  const CONTROL_SOURCE = "calm-spotifyplayback-control";
  const DEBUG = true;
  const mediaElements = new Set();
  const nativePlaybackRate = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    "playbackRate"
  );
  const nativeCreateElement = document.createElement;
  const NativeAudio = window.Audio;
  const settings = {
    enabled: true,
    speed: 1,
    preservePitch: true
  };
  let applyCount = 0;
  let interceptCount = 0;

  function debugLog(...args) {
    if (DEBUG) {
      console.info("[Calm Spotify][page]", ...args);
    }
  }

  function clampSpeed(value) {
    const speed = Number(value);
    if (!Number.isFinite(speed)) {
      return 1;
    }

    return Math.max(0.25, Math.min(4, Math.round(speed * 100) / 100));
  }

  function isSpotifyCanvasVideo(media) {
    if (!(media instanceof HTMLVideoElement)) {
      return false;
    }

    const container = media.closest('[class*="canvas" i], [data-testid*="canvas" i]');
    if (container) {
      return true;
    }

    const rect = media.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.width <= 220 && rect.height <= 220;
  }

  function shouldControl(media) {
    if (!(media instanceof HTMLMediaElement)) {
      return false;
    }

    if (media instanceof HTMLAudioElement) {
      return true;
    }

    return !isSpotifyCanvasVideo(media);
  }

  function setPreservePitch(media, value) {
    try {
      media.preservesPitch = value;
    } catch {
      // Some browser/media combinations expose this as read-only.
    }

    try {
      media.mozPreservesPitch = value;
    } catch {
      // Firefox compatibility, harmless elsewhere.
    }

    try {
      media.webkitPreservesPitch = value;
    } catch {
      // Safari/Chromium compatibility, harmless elsewhere.
    }
  }

  function trackMedia(media) {
    if (!(media instanceof HTMLMediaElement) || mediaElements.has(media)) {
      return;
    }

    mediaElements.add(media);
    debugLog("tracking media", {
      tagName: media.tagName,
      src: media.currentSrc || media.src || "",
      totalTracked: mediaElements.size
    });
    media.addEventListener(
      "loadedmetadata",
      () => {
        applyToMedia(media);
      },
      true
    );
    media.addEventListener(
      "play",
      () => {
        applyToMedia(media);
      },
      true
    );
    applyToMedia(media);
  }

  function applyToMedia(media) {
    if (!shouldControl(media)) {
      if (isSpotifyCanvasVideo(media)) {
        debugLog("skipping canvas video", {
          tagName: media.tagName,
          width: media.getBoundingClientRect().width,
          height: media.getBoundingClientRect().height
        });
      }
      return;
    }

    setPreservePitch(media, true);
    media.playbackRate = {
      source: CONTROL_SOURCE,
      value: settings.enabled ? settings.speed : 1
    };
    applyCount += 1;
    if (applyCount <= 20 || applyCount % 25 === 0) {
      debugLog("applied speed", {
        tagName: media.tagName,
        speed: settings.enabled ? settings.speed : 1,
        actualPlaybackRate: media.playbackRate,
        preservesPitch: media.preservesPitch,
        totalTracked: mediaElements.size,
        applyCount
      });
    }
  }

  function applyToAllMedia() {
    document.querySelectorAll("audio, video").forEach(trackMedia);
    mediaElements.forEach((media) => {
      if (!document.contains(media)) {
        mediaElements.delete(media);
        return;
      }

      applyToMedia(media);
    });
  }

  if (nativePlaybackRate?.get && nativePlaybackRate?.set) {
    Object.defineProperty(HTMLMediaElement.prototype, "playbackRate", {
      configurable: true,
      enumerable: nativePlaybackRate.enumerable,
      get() {
        return nativePlaybackRate.get.call(this);
      },
      set(value) {
        if (value && typeof value === "object" && value.source === CONTROL_SOURCE) {
          nativePlaybackRate.set.call(this, Number(value.value));
          return;
        }

        if (isSpotifyCanvasVideo(this)) {
          nativePlaybackRate.set.call(this, 1);
          return;
        }

        if (settings.enabled && shouldControl(this)) {
          nativePlaybackRate.set.call(this, settings.speed);
          interceptCount += 1;
          if (interceptCount <= 20 || interceptCount % 25 === 0) {
            debugLog("intercepted playbackRate write", {
              requested: value,
              forced: settings.speed,
              tagName: this.tagName,
              interceptCount
            });
          }
          return;
        }

        nativePlaybackRate.set.call(this, value);
      }
    });
  }

  document.createElement = function createElement(name, options) {
    const element =
      options === undefined
        ? nativeCreateElement.call(document, name)
        : nativeCreateElement.call(document, name, options);
    if (String(name).toLowerCase() === "audio" || String(name).toLowerCase() === "video") {
      debugLog("document.createElement media", String(name).toLowerCase());
      trackMedia(element);
    }
    return element;
  };

  if (typeof NativeAudio === "function") {
    window.Audio = function Audio(...args) {
      const audio = new NativeAudio(...args);
      debugLog("new Audio()", {
        src: args[0] || ""
      });
      trackMedia(audio);
      return audio;
    };
    window.Audio.prototype = NativeAudio.prototype;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== MESSAGE_SOURCE) {
      return;
    }

    if (event.data.type !== "settings") {
      return;
    }

    settings.enabled = Boolean(event.data.settings?.enabled);
    settings.speed = clampSpeed(event.data.settings?.speed);
    settings.preservePitch = true;
    debugLog("received settings", settings);
    applyToAllMedia();
  });

  new MutationObserver(applyToAllMedia).observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  debugLog("page script initialized");
  applyToAllMedia();
})();
