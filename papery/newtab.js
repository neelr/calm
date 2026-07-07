// New-tab page: bounce straight to the configured Papery instance. Extension
// pages can't be remote URLs, so this local page redirects. Falls back to a
// hint if Papery hasn't been connected yet.
chrome.storage.local.get({ paperyEndpoint: "" }, (s) => {
  const endpoint = String(s.paperyEndpoint || "")
    .trim()
    .replace(/\/+$/, "");
  if (endpoint) {
    location.replace(endpoint);
  } else {
    document.getElementById("hint").hidden = false;
  }
});
