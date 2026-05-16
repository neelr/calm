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
    preservePitch: true,
    visualizerEnabled: false
  };
  let applyCount = 0;
  let interceptCount = 0;
  let audioContext;
  let analyser;
  let frequencyData;
  let analysedMedia;
  let analysisSource;
  let analysisRaf;
  let playbackStateTimer;
  let lastMediaReportAt = 0;
  let lastMode = "";
  let lastAnalyserReportAt = 0;

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

  function postAnalysis(energy, bass, treble, mode, samples = []) {
    window.postMessage(
      {
        source: MESSAGE_SOURCE,
        type: "analysis",
        energy,
        bass,
        treble,
        mode,
        samples
      },
      "*"
    );
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

  function describeMedia(media) {
    const rect = media.getBoundingClientRect();

    return {
      tagName: media.tagName,
      controlled: shouldControl(media),
      canvasVideo: isSpotifyCanvasVideo(media),
      paused: media.paused,
      ended: media.ended,
      muted: media.muted,
      volume: media.volume,
      readyState: media.readyState,
      networkState: media.networkState,
      currentTime: Number.isFinite(media.currentTime) ? Math.round(media.currentTime * 100) / 100 : null,
      duration: Number.isFinite(media.duration) ? Math.round(media.duration * 100) / 100 : null,
      playbackRate: media.playbackRate,
      currentSrc: media.currentSrc || media.src || "",
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      connected: document.contains(media)
    };
  }

  function reportMediaState(reason, force = false) {
    const now = performance.now();
    if (!force && now - lastMediaReportAt < 1500) {
      return;
    }

    lastMediaReportAt = now;
    const tracked = Array.from(mediaElements);
    const domMedia = Array.from(document.querySelectorAll("audio, video"));
    debugLog("media state", {
      reason,
      trackedCount: tracked.length,
      domCount: domMedia.length,
      tracked: tracked.map(describeMedia),
      dom: domMedia.map(describeMedia)
    });
  }

  function getAnalysisMedia() {
    const tracked = Array.from(mediaElements).filter((media) => {
      return shouldControl(media) && !media.paused && !media.ended;
    });
    if (!tracked.length) {
      reportMediaState("no playable tracked media");
    }
    return tracked[0] || null;
  }

  function postPlaybackState(reason, force = false) {
    if (!settings.visualizerEnabled && !force) {
      return;
    }

    const media = getAnalysisMedia();
    window.postMessage(
      {
        source: MESSAGE_SOURCE,
        type: "playback-state",
        playing: Boolean(media),
        reason,
        media: media ? describeMedia(media) : null
      },
      "*"
    );
  }

  function ensureAudioContext() {
    if (!audioContext) {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) {
        return null;
      }
      audioContext = new AudioContextCtor();
    }

    if (audioContext.state === "suspended") {
      void audioContext.resume();
    }

    return audioContext;
  }

  function connectAnalyser(media) {
    if (!media || analysedMedia === media && analyser) {
      return Boolean(analyser);
    }

    const context = ensureAudioContext();
    if (!context) {
      return false;
    }

    try {
      const nextAnalyser = context.createAnalyser();
      nextAnalyser.fftSize = 512;
      nextAnalyser.smoothingTimeConstant = 0.72;

      let source;
      let mode = "mediaElementSource";
      if (typeof media.captureStream === "function") {
        const stream = media.captureStream();
        debugLog("captureStream inspected", {
          tagName: media.tagName,
          audioTracks: stream?.getAudioTracks?.().length ?? 0,
          videoTracks: stream?.getVideoTracks?.().length ?? 0
        });
        if (stream?.getAudioTracks?.().length) {
          source = context.createMediaStreamSource(stream);
          source.connect(nextAnalyser);
          mode = "captureStream";
        }
      }

      if (!source) {
        source = context.createMediaElementSource(media);
        source.connect(nextAnalyser);
        nextAnalyser.connect(context.destination);
      }

      analyser = nextAnalyser;
      frequencyData = new Uint8Array(analyser.frequencyBinCount);
      analysedMedia = media;
      analysisSource = source;
      debugLog("audio analyser connected", {
        mode,
        tagName: media.tagName,
        media: describeMedia(media),
        bins: frequencyData.length
      });
      return true;
    } catch (error) {
      debugLog("audio analyser unavailable", {
        error: String(error),
        media: media ? describeMedia(media) : null
      });
      analyser = undefined;
      frequencyData = undefined;
      analysedMedia = undefined;
      analysisSource = undefined;
      return false;
    }
  }

  function runAnalysis() {
    if (!settings.visualizerEnabled) {
      analysisRaf = undefined;
      return;
    }

    const media = getAnalysisMedia();
    if (!media) {
      if (lastMode !== "paused") {
        lastMode = "paused";
        reportMediaState("posting paused", true);
      }
      postAnalysis(0, 0, 0, "paused");
      analysisRaf = window.requestAnimationFrame(runAnalysis);
      return;
    }

    const connected = connectAnalyser(media);
    if (connected && analyser && frequencyData) {
      analyser.getByteFrequencyData(frequencyData);
      const length = frequencyData.length;
      const bass = getAverage(frequencyData, 0, Math.max(1, Math.floor(length * 0.14)));
      const mid = getAverage(
        frequencyData,
        Math.floor(length * 0.14),
        Math.max(2, Math.floor(length * 0.55))
      );
      const treble = getAverage(frequencyData, Math.floor(length * 0.55), length);
      const energy = Math.max(bass, mid * 0.8, treble * 0.65);
      const samples = [];
      const sampleCount = 48;
      for (let index = 0; index < sampleCount; index += 1) {
        const start = Math.floor((index / sampleCount) * length);
        const end = Math.max(start + 1, Math.floor(((index + 1) / sampleCount) * length));
        samples.push(getAverage(frequencyData, start, end));
      }
      const now = performance.now();
      if (lastMode !== "analyser" || now - lastAnalyserReportAt > 3000) {
        lastMode = "analyser";
        lastAnalyserReportAt = now;
        debugLog("analysis frame", {
          media: describeMedia(media),
          bass,
          mid,
          treble,
          energy,
          sampleMax: Math.max(...samples),
          sampleAvg: samples.reduce((sum, value) => sum + value, 0) / samples.length
        });
      }
      postAnalysis(energy, bass, treble, "analyser", samples);
    } else {
      if (lastMode !== "unavailable") {
        lastMode = "unavailable";
        reportMediaState("posting unavailable", true);
      }
      postAnalysis(0, 0, 0, "unavailable");
    }

    analysisRaf = window.requestAnimationFrame(runAnalysis);
  }

  function startAnalysis() {
    if (analysisRaf) {
      return;
    }

    debugLog("starting visualizer analysis");
    reportMediaState("startAnalysis", true);
    analysisRaf = window.requestAnimationFrame(runAnalysis);
  }

  function stopAnalysis() {
    if (analysisRaf) {
      window.cancelAnimationFrame(analysisRaf);
      analysisRaf = undefined;
    }
    postAnalysis(0, 0, 0, "off");
  }

  function startPlaybackStatePolling() {
    if (playbackStateTimer) {
      return;
    }

    playbackStateTimer = window.setInterval(() => {
      postPlaybackState("poll");
    }, 750);
    postPlaybackState("poll-start", true);
  }

  function stopPlaybackStatePolling() {
    if (!playbackStateTimer) {
      return;
    }

    window.clearInterval(playbackStateTimer);
    playbackStateTimer = undefined;
    postPlaybackState("poll-stop", true);
  }

  function trackMedia(media) {
    if (!(media instanceof HTMLMediaElement) || mediaElements.has(media)) {
      return;
    }

    mediaElements.add(media);
    debugLog("tracking media", {
      media: describeMedia(media),
      totalTracked: mediaElements.size
    });
    media.addEventListener(
      "loadedmetadata",
      () => {
        debugLog("media loadedmetadata", describeMedia(media));
        applyToMedia(media);
      },
      true
    );
    media.addEventListener(
      "play",
      () => {
        debugLog("media play event", describeMedia(media));
        applyToMedia(media);
        postPlaybackState("play", true);
      },
      true
    );
    media.addEventListener(
      "pause",
      () => {
        debugLog("media pause event", describeMedia(media));
        postPlaybackState("pause", true);
      },
      true
    );
    media.addEventListener(
      "ended",
      () => {
        debugLog("media ended event", describeMedia(media));
        postPlaybackState("ended", true);
      },
      true
    );
    applyToMedia(media);
    postPlaybackState("trackMedia");
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
    settings.visualizerEnabled = Boolean(event.data.settings?.visualizerEnabled);
    debugLog("received settings", settings);
    applyToAllMedia();
    stopAnalysis();
    if (settings.visualizerEnabled) {
      startPlaybackStatePolling();
    } else {
      stopPlaybackStatePolling();
    }
    postPlaybackState("settings", true);
  });

  new MutationObserver(applyToAllMedia).observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  debugLog("page script initialized");
  applyToAllMedia();
})();
