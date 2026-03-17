(function () {
  async function init() {
    const result = await chrome.storage.local.get({ xEnabled: true });
    if (!result.xEnabled) {
      return;
    }

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("x/page-script.js");
    script.onload = () => script.remove();
    document.documentElement.appendChild(script);
  }

  void init();
})();
