(function () {
  let observer;
  let initialized = false;

  async function isEnabled() {
    const result = await chrome.storage.local.get({ youtubeEnabled: true });
    return result.youtubeEnabled;
  }

  function setEnabledFlag(enabled) {
    if (enabled) {
      document.documentElement.dataset.calmYoutubeEnabled = "true";
      return;
    }

    delete document.documentElement.dataset.calmYoutubeEnabled;
    delete document.documentElement.dataset.calmYoutubePage;
  }

  const PAGE_FLAGS = {
    HOME: "calm-home",
    WATCH: "calm-watch",
    OTHER: "calm-other"
  };

  const SHORTS_LINK_SELECTORS = [
    'a[href^="/shorts"]',
    'a[href*="youtube.com/shorts"]'
  ];

  function getYoutubePageFlag(pathname) {
    if (pathname === "/") {
      return PAGE_FLAGS.HOME;
    }

    if (pathname === "/watch") {
      return PAGE_FLAGS.WATCH;
    }

    return PAGE_FLAGS.OTHER;
  }

  function setYoutubePageFlag() {
    document.documentElement.dataset.calmYoutubePage = getYoutubePageFlag(window.location.pathname);
  }

  function hideYoutubeShortsEntries() {
    document.querySelectorAll(SHORTS_LINK_SELECTORS.join(",")).forEach((link) => {
      const navItem = link.closest(
        "ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer, ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer, ytd-rich-section-renderer"
      );

      if (navItem) {
        navItem.style.display = "none";
      }
    });
  }

  function hideYoutubeMatchingContainers(matchers) {
    const textSelectors = [
      "#title",
      "#title-text",
      "#header",
      "#headline",
      "#details",
      "#metadata",
      "#content-text",
      ".badge",
      ".ytd-badge-supported-renderer",
      "yt-formatted-string"
    ];

    const containerSelector = [
      "ytd-rich-section-renderer",
      "ytd-rich-item-renderer",
      "ytd-video-renderer",
      "ytd-compact-video-renderer",
      "ytd-grid-video-renderer",
      "ytd-shelf-renderer",
      "ytd-item-section-renderer",
      "ytd-search-pyv-renderer",
      "ytd-ad-slot-renderer",
      "ytd-display-ad-renderer",
      "ytd-promoted-sparkles-web-renderer",
      "ytd-in-feed-ad-layout-renderer",
      "ytd-banner-promo-renderer"
    ].join(", ");

    document.querySelectorAll(textSelectors.join(",")).forEach((node) => {
      const text = (node.textContent || "").trim().toLowerCase();
      if (!text) {
        return;
      }

      const shouldHide = matchers.some((matcher) => text.includes(matcher));
      if (!shouldHide) {
        return;
      }

      const container = node.closest(containerSelector);
      if (container) {
        container.style.display = "none";
      }
    });
  }

  function hideYoutubeSponsoredAndNews() {
    hideYoutubeMatchingContainers([
      "sponsored",
      "paid promotion",
      "includes paid promotion",
      "promoted"
    ]);

    hideYoutubeMatchingContainers([
      "news"
    ]);
  }

  function removeYoutubeHomeDistractions() {
    if (document.documentElement.dataset.calmYoutubePage !== PAGE_FLAGS.HOME) {
      return;
    }

    const app = document.querySelector("ytd-app");
    if (app) {
      app.removeAttribute("guide-persistent-and-visible");
    }
  }

  function applyCleanup() {
    setYoutubePageFlag();
    hideYoutubeShortsEntries();
    hideYoutubeSponsoredAndNews();
    removeYoutubeHomeDistractions();
  }

  let lastUrl = window.location.href;

  async function init() {
    const enabled = await isEnabled();
    setEnabledFlag(enabled);
    if (!enabled || initialized) {
      return;
    }
    initialized = true;

    observer = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        setYoutubePageFlag();
      }

      applyCleanup();
    });

    setYoutubePageFlag();

    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    }

    window.addEventListener("yt-navigate-finish", applyCleanup, true);
    window.addEventListener("popstate", applyCleanup, true);
    document.addEventListener("DOMContentLoaded", applyCleanup, { once: true });
    applyCleanup();
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.youtubeEnabled) {
      return;
    }

    const enabled = changes.youtubeEnabled.newValue;
    setEnabledFlag(enabled);

    if (!enabled && observer) {
      observer.disconnect();
      observer = undefined;
      initialized = false;
      return;
    }

    if (enabled) {
      init();
    }
  });

  init();
})();
