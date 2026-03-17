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
    videospeedEnabled: true
  });

  settings.adblockEnabled = await isAdblockEnabled();
  return settings;
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

  youtubeEnabled.checked = settings.youtubeEnabled;
  xEnabled.checked = settings.xEnabled;
  adblockEnabled.checked = settings.adblockEnabled;
  videospeedEnabled.checked = settings.videospeedEnabled;

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
}

init();
