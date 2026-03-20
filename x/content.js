(function () {
  let initialized = false;

  async function isEnabled() {
    const result = await chrome.storage.local.get({ xEnabled: true });
    return result.xEnabled;
  }

  function setEnabledFlag(enabled) {
    if (enabled) {
      document.documentElement.dataset.calmXEnabled = "true";
      return;
    }

    delete document.documentElement.dataset.calmXEnabled;
    delete document.documentElement.dataset.calmTwitterPage;
  }

  const revealedVideos = new Set();
  let cleanupScheduled = false;
  const DEBUG = true;

  function debugLog(...args) {
    if (!DEBUG) {
      return;
    }

    console.log("[Calm Feed][X]", ...args);
  }

  function hidePromotedContent() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach((tweet) => {
      const text = (tweet.textContent || "").toLowerCase();
      if (text.includes("promoted")) {
        tweet.style.display = "none";
      }
    });

    document.querySelectorAll('[data-testid="UserCell"], [data-testid="placementTracking"]').forEach((node) => {
      const text = (node.textContent || "").toLowerCase();
      if (text.includes("promoted") || text.includes("who to follow") || text.includes("follow topic")) {
        node.style.display = "none";
      }
    });
  }

  function getTweetId(tweet) {
    const statusLink = tweet.querySelector('a[href*="/status/"]');
    if (!statusLink) {
      return null;
    }

    const match = statusLink.getAttribute("href").match(/status\/(\d+)/);
    return match ? match[1] : null;
  }

  function revealVideo(tweetId) {
    if (!tweetId) {
      debugLog("revealVideo skipped: missing tweetId");
      return;
    }

    revealedVideos.add(tweetId);
    debugLog("revealVideo", tweetId, "revealedCount", revealedVideos.size);
  }

  function hideVideo(tweetId) {
    if (!tweetId) {
      debugLog("hideVideo skipped: missing tweetId");
      return;
    }

    revealedVideos.delete(tweetId);
    debugLog("hideVideo", tweetId, "revealedCount", revealedVideos.size);
  }

  function isVideoRevealed(tweetId) {
    if (!tweetId) {
      return false;
    }

    return revealedVideos.has(tweetId);
  }

  function attachVideoToggles() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach((tweet) => {
      const video = tweet.querySelector('[data-testid="videoComponent"]');
      if (!video) {
        return;
      }

      const tweetId = getTweetId(tweet);
      if (!tweetId) {
        debugLog("attachVideoToggles skipped: missing tweetId");
        return;
      }

      tweet.dataset.calmTwitterVideo = isVideoRevealed(tweetId) ? "shown" : "hidden";

      const mediaContainer = video.closest(
        '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [role="link"], div[aria-label][tabindex="0"]'
      ) || video.parentElement;
      if (!mediaContainer) {
        debugLog("attachVideoToggles skipped: missing mediaContainer", tweetId);
        return;
      }

      mediaContainer.classList.add("calm-twitter-video-container");
      const mediaRegion = mediaContainer.closest('[aria-labelledby]') || mediaContainer.parentElement;
      if (!mediaRegion) {
        debugLog("attachVideoToggles skipped: missing mediaRegion", tweetId);
        return;
      }

      mediaRegion.classList.add("calm-twitter-media-region");

      let toggle = tweet.querySelector(".calm-twitter-video-toggle");
      if (!toggle) {
        toggle = document.createElement("a");
        toggle.href = "#";
        toggle.className = "calm-twitter-video-toggle";
        toggle.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          debugLog("toggle click", tweetId, {
            hiddenState: tweet.dataset.calmTwitterVideo
          });

          if (tweet.dataset.calmTwitterVideo === "shown") {
            hideVideo(tweetId);
            tweet.dataset.calmTwitterVideo = "hidden";
            toggle.textContent = "[show video]";
            return;
          }

          revealVideo(tweetId);
          tweet.dataset.calmTwitterVideo = "shown";
          toggle.textContent = "[hide video]";
        });

        mediaRegion.insertAdjacentElement("beforebegin", toggle);
        debugLog("toggle inserted", tweetId);
      }

      toggle.textContent = tweet.dataset.calmTwitterVideo === "shown" ? "[hide video]" : "[show video]";
    });
  }

  function hideTodaysNews() {
    document.querySelectorAll('[data-testid="cellInnerDiv"]').forEach((cell) => {
      const link = cell.querySelector('a[href="/explore"]');
      if (!link) {
        return;
      }

      const heading = cell.querySelector("h2");
      if (heading && heading.textContent.trim().includes("Today's News")) {
        cell.style.display = "none";
        return;
      }

      if (!heading && link.textContent.trim() === "Show more") {
        cell.style.display = "none";
      }
    });
  }

  function cleanupX() {
    document.documentElement.dataset.calmTwitterPage = "timeline";
    debugLog("cleanupX start");
    hidePromotedContent();
    hideTodaysNews();
    attachVideoToggles();
    debugLog("cleanupX end");
  }

  function applyCleanup() {
    cleanupScheduled = false;
    cleanupX();
  }

  function scheduleCleanup() {
    if (cleanupScheduled) {
      debugLog("scheduleCleanup skipped: already scheduled");
      return;
    }

    cleanupScheduled = true;
    debugLog("scheduleCleanup queued");
    window.requestAnimationFrame(applyCleanup);
  }

  let lastUrl = window.location.href;

  const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      debugLog("url changed", lastUrl, "->", window.location.href);
      lastUrl = window.location.href;
    }

    scheduleCleanup();
  });

  async function init() {
    const enabled = await isEnabled();
    setEnabledFlag(enabled);
    if (!enabled || initialized) {
      return;
    }
    initialized = true;

    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    }

    window.addEventListener("popstate", scheduleCleanup, true);
    document.addEventListener("DOMContentLoaded", scheduleCleanup, { once: true });
    applyCleanup();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.xEnabled) {
      return;
    }

    const enabled = changes.xEnabled.newValue;
    setEnabledFlag(enabled);

    if (!enabled) {
      observer.disconnect();
      initialized = false;
      return;
    }

    init();
  });

  init();
})();
