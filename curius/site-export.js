/**
 * On curius.app only: bottom-left panel with JSON export of cookies (for pasting
 * into the Calm Feed popup). Shown when "Curius (page saves)" is enabled.
 */
(function () {
  const ROOT_ID = "calm-curius-site-export";

  function sendExport() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { scope: "curius", type: "exportCuriusCookies" },
          resolve
        );
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, resolve);
    });
  }

  async function isCuriusEnabled() {
    const cfg = await storageGet({ curiusEnabled: false });
    return !!cfg.curiusEnabled;
  }

  function removeRoot() {
    document.getElementById(ROOT_ID)?.remove();
  }

  async function build() {
    if (!(await isCuriusEnabled())) {
      removeRoot();
      return;
    }
    if (document.getElementById(ROOT_ID)) {
      return;
    }

    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `
      <div class="calm-curius-site-title">Calm Feed — session export</div>
      <p class="calm-curius-site-hint">Copy this JSON, then in the Calm Feed popup click <strong>Log in</strong> and paste it.</p>
      <textarea readonly aria-label="Curius cookie export JSON"></textarea>
      <div class="calm-curius-site-actions">
        <button type="button" class="calm-curius-site-primary" data-copy>Copy</button>
        <button type="button" data-refresh>Refresh</button>
      </div>
    `;

    const ta = root.querySelector("textarea");

    async function fill() {
      const res = await sendExport();
      if (res?.ok && res.json) {
        ta.value = res.json;
      } else {
        ta.value =
          "// Could not read cookies. Reload the page or check the Calm Feed extension.";
      }
    }

    root.querySelector("[data-copy]").addEventListener("click", async () => {
      try {
        ta.select();
        await navigator.clipboard.writeText(ta.value);
      } catch {
        try {
          document.execCommand("copy");
        } catch {
          /* ignore */
        }
      }
    });

    root.querySelector("[data-refresh]").addEventListener("click", fill);

    const host = document.body || document.documentElement;
    host.appendChild(root);
    await fill();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.curiusEnabled) {
      return;
    }
    if (changes.curiusEnabled.newValue) {
      build();
    } else {
      removeRoot();
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build, { once: true });
  } else {
    build();
  }
})();
