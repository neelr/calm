(() => {
  const STATE = new WeakMap();
  const MAX_IMAGE_SIDE = 2000;
  const PDF_IMAGE_MAX_SIDE = 2400;
  let enabled = false;
  let busy = false;
  let translatingPdf = false;
  let statusEl;
  let translatePdfButton;
  let progressEl;
  let progressFillEl;
  let progressTextEl;

  function isChapterPage() {
    return /^\/chapter\/[0-9a-f-]+/i.test(location.pathname);
  }

  function setStatus(text, level = "") {
    if (!statusEl) {
      statusEl = document.createElement("div");
      statusEl.className = "calm-md-status";
      document.documentElement.append(statusEl);
    }
    statusEl.textContent = text;
    statusEl.dataset.level = level;
  }

  function setProgress(done, total, label = "") {
    if (!progressEl) {
      progressEl = document.createElement("div");
      progressEl.className = "calm-md-progress";
      progressFillEl = document.createElement("div");
      progressFillEl.className = "calm-md-progress-fill";
      progressTextEl = document.createElement("div");
      progressTextEl.className = "calm-md-progress-text";
      progressEl.append(progressFillEl, progressTextEl);
      document.documentElement.append(progressEl);
    }
    const pct = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
    progressFillEl.style.width = `${pct}%`;
    progressTextEl.textContent = label || `${done}/${total}`;
    progressEl.hidden = total <= 0;
  }

  function chapterIdFromLocation() {
    const match = location.pathname.match(/^\/chapter\/([0-9a-f-]+)/i);
    return match ? match[1] : "";
  }

  function safeFilename(name) {
    return String(name || "mangadex-chapter")
      .replace(/[^\w .-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "mangadex-chapter";
  }

  function getReaderImages() {
    return Array.from(
      document.querySelectorAll(".md--reader-pages img, .md--page img, img.img.sp")
    ).filter((img) => img instanceof HTMLImageElement);
  }

  function isVisibleImage(img) {
    const rect = img.getBoundingClientRect();
    const style = getComputedStyle(img);
    return (
      img.complete &&
      img.naturalWidth > 0 &&
      img.naturalHeight > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 80 &&
      rect.height > 80 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth
    );
  }

  function imageToDataUrl(img) {
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    drawCoordinateGrid(ctx, width, height);
    return canvas.toDataURL("image/jpeg", 0.9);
  }

  function drawCoordinateGrid(ctx, width, height) {
    ctx.save();
    ctx.lineWidth = Math.max(1, Math.round(Math.min(width, height) / 900));
    ctx.font = `${Math.max(10, Math.round(width / 90))}px ui-monospace, monospace`;
    ctx.textBaseline = "top";

    for (let pct = 0; pct <= 100; pct += 10) {
      const x = Math.round((pct / 100) * width);
      const y = Math.round((pct / 100) * height);
      const major = pct === 0 || pct === 50 || pct === 100;

      ctx.strokeStyle = major ? "rgba(255, 0, 0, 0.32)" : "rgba(255, 0, 0, 0.18)";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();

      ctx.fillStyle = major ? "rgba(255, 0, 0, 0.72)" : "rgba(255, 0, 0, 0.5)";
      if (pct > 0 && pct < 100) {
        ctx.fillText(String(pct), Math.min(x + 3, width - 22), 3);
        ctx.fillText(String(pct), 3, Math.min(y + 3, height - 14));
      }
    }
    ctx.restore();
  }

  async function getChapterImageUrls() {
    const chapterId = chapterIdFromLocation();
    if (!chapterId) {
      throw new Error("Could not find chapter id");
    }
    const response = await fetch(`https://api.mangadex.org/at-home/server/${chapterId}`);
    if (!response.ok) {
      throw new Error(`MangaDex API failed (${response.status})`);
    }
    const data = await response.json();
    const baseUrl = data?.baseUrl;
    const hash = data?.chapter?.hash;
    const pages = data?.chapter?.data;
    if (!baseUrl || !hash || !Array.isArray(pages) || pages.length === 0) {
      throw new Error("MangaDex API returned no pages");
    }
    return pages.map((page) => `${baseUrl}/data/${hash}/${page}`);
  }

  function canvasToJpegBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Could not encode page image"));
        }
      }, "image/jpeg", 0.92);
    });
  }

  async function blobToJpegCanvasData(blob) {
    const bitmap = await createImageBitmap(blob);
    try {
      const scale = Math.min(1, PDF_IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      const jpeg = await canvasToJpegBlob(canvas);
      return {
        width,
        height,
        dataUrl: await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(jpeg);
        }),
        bytes: new Uint8Array(await jpeg.arrayBuffer()),
      };
    } finally {
      bitmap.close();
    }
  }

  async function dataUrlToJpegPage(dataUrl) {
    const response = await fetch(dataUrl);
    return blobToJpegCanvasData(await response.blob());
  }

  async function fetchPageBlob(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Image failed (${response.status})`);
    }
    return response.blob();
  }

  function buildPdf(pages) {
    const encoder = new TextEncoder();
    const chunks = [];
    const offsets = [0];
    let offset = 0;

    function push(part) {
      const bytes = typeof part === "string" ? encoder.encode(part) : part;
      chunks.push(bytes);
      offset += bytes.byteLength;
    }

    function object(id, body) {
      offsets[id] = offset;
      push(`${id} 0 obj\n${body}\nendobj\n`);
    }

    function streamObject(id, dict, bytes) {
      offsets[id] = offset;
      push(`${id} 0 obj\n${dict}\nstream\n`);
      push(bytes);
      push("\nendstream\nendobj\n");
    }

    push("%PDF-1.4\n");
    object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    object(
      2,
      `<< /Type /Pages /Count ${pages.length} /Kids [${
        pages.map((_, index) => `${3 + index * 3} 0 R`).join(" ")
      }] >>`
    );

    pages.forEach((page, index) => {
      const pageId = 3 + index * 3;
      const imageId = pageId + 1;
      const contentId = pageId + 2;
      const draw = `q\n${page.width} 0 0 ${page.height} 0 0 cm\n/Im0 Do\nQ\n`;
      object(
        pageId,
        [
          "<< /Type /Page",
          "/Parent 2 0 R",
          `/MediaBox [0 0 ${page.width} ${page.height}]`,
          `/Resources << /XObject << /Im0 ${imageId} 0 R >> >>`,
          `/Contents ${contentId} 0 R`,
          ">>",
        ].join(" ")
      );
      streamObject(
        imageId,
        [
          "<< /Type /XObject /Subtype /Image",
          `/Width ${page.width}`,
          `/Height ${page.height}`,
          "/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
          `/Length ${page.bytes.byteLength} >>`,
        ].join(" "),
        page.bytes
      );
      streamObject(
        contentId,
        `<< /Length ${encoder.encode(draw).byteLength} >>`,
        encoder.encode(draw)
      );
    });

    const xrefOffset = offset;
    push(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
    for (let id = 1; id < offsets.length; id += 1) {
      push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
    }
    push(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
    return new Blob(chunks, { type: "application/pdf" });
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function translatePageForPdf(url, pageNumber, pageCount) {
    const source = await blobToJpegCanvasData(await fetchPageBlob(url));
    const response = await chrome.runtime.sendMessage({
      scope: "calm-mangadex",
      type: "translatePageImage",
      imageDataUrl: source.dataUrl,
      pageNumber,
      pageCount,
    });
    if (!response?.ok) {
      const message = response?.error === "missing_api_key"
        ? "Add OpenAI API key"
        : response?.error || "OpenAI image edit failed";
      console.warn(`[Calm Feed] MangaDex page ${pageNumber} translation failed; using original page`, message);
      return { ...source, fallback: true, error: message };
    }
    return dataUrlToJpegPage(response.imageDataUrl);
  }

  async function translateChapterPdf() {
    if (translatingPdf) {
      return;
    }
    translatingPdf = true;
    translatePdfButton.disabled = true;
    translatePdfButton.textContent = "Translating...";
    try {
      setStatus("Translate PDF: finding pages");
      setProgress(0, 1, "Finding pages");
      const urls = await getChapterImageUrls();
      setProgress(0, urls.length, `0/${urls.length}`);
      let done = 0;
      let fallbackCount = 0;
      const pages = await Promise.all(urls.map(async (url, index) => {
        setStatus(`Translate PDF: started ${index + 1}/${urls.length}`);
        const page = await translatePageForPdf(url, index + 1, urls.length);
        if (page.fallback) {
          fallbackCount += 1;
        }
        done += 1;
        const suffix = fallbackCount ? `, ${fallbackCount} original` : "";
        setProgress(done, urls.length, `${done}/${urls.length}${suffix}`);
        setStatus(`Translate PDF: ${done}/${urls.length}${suffix}`);
        return page;
      }));
      setStatus("Translate PDF: building");
      setProgress(urls.length, urls.length, "Building PDF");
      const pdf = buildPdf(pages);
      saveBlob(pdf, `${safeFilename(document.title)} translated.pdf`);
      setStatus(
        fallbackCount
          ? `Translate PDF: downloaded (${fallbackCount} original fallback)`
          : `Translate PDF: downloaded ${pages.length} pages`
      );
      setProgress(0, 0);
    } catch (error) {
      console.error("[Calm Feed] MangaDex translated PDF failed", error);
      setStatus(`Translate PDF: ${error.message || "failed"}`, "error");
    } finally {
      translatingPdf = false;
      translatePdfButton.disabled = false;
      translatePdfButton.textContent = "Translate PDF";
    }
  }

  function initTranslatePdfButton() {
    if (!isChapterPage() || translatePdfButton) {
      return;
    }
    translatePdfButton = document.createElement("button");
    translatePdfButton.type = "button";
    translatePdfButton.className = "calm-md-pdf-button";
    translatePdfButton.textContent = "Translate PDF";
    translatePdfButton.title = "Translate MangaDex chapter with GPT Image and download as PDF";
    translatePdfButton.addEventListener("click", () => {
      void translateChapterPdf();
    });
    document.documentElement.append(translatePdfButton);
  }

  function ensureOverlay(img) {
    let state = STATE.get(img);
    if (state?.overlay) {
      return state;
    }
    const overlay = document.createElement("div");
    overlay.className = "calm-md-overlay";
    document.body.append(overlay);
    state = { overlay, status: "new" };
    STATE.set(img, state);
    return state;
  }

  function positionOverlay(img, overlay) {
    const rect = img.getBoundingClientRect();
    overlay.style.left = `${rect.left + scrollX}px`;
    overlay.style.top = `${rect.top + scrollY}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.hidden = !isVisibleImage(img);
  }

  function fitBoxText(box, basePx) {
    const minPx = 6;
    let size = Math.floor(basePx);
    box.style.fontSize = `${size}px`;
    for (let i = 0; i < 18; i += 1) {
      if (
        box.scrollHeight <= box.clientHeight + 1 &&
        box.scrollWidth <= box.clientWidth + 1
      ) {
        return;
      }
      size = Math.max(minPx, size - 1);
      box.style.fontSize = `${size}px`;
      if (size <= minPx) {
        return;
      }
    }
  }

  function fontSizeForBox(overlay, h) {
    const rect = overlay.getBoundingClientRect();
    return Math.max(8, Math.min(15, rect.width * Math.max(0.0064, h * 0.0019)));
  }

  function renderOverlay(img, result) {
    const state = ensureOverlay(img);
    const overlay = state.overlay;
    overlay.replaceChildren();
    positionOverlay(img, overlay);

    for (const item of result.items || []) {
      const legacyX = Number(item.x);
      const legacyY = Number(item.y);
      const legacyW = Number(item.w);
      const legacyH = Number(item.h);
      const rawX1 = Number.isFinite(Number(item.x1)) ? Number(item.x1) : legacyX;
      const rawY1 = Number.isFinite(Number(item.y1)) ? Number(item.y1) : legacyY;
      const rawX2 = Number.isFinite(Number(item.x2)) ? Number(item.x2) : legacyX + legacyW;
      const rawY2 = Number.isFinite(Number(item.y2)) ? Number(item.y2) : legacyY + legacyH;
      const x1 = Math.max(0, Math.min(99, Math.min(rawX1, rawX2)));
      const y1 = Math.max(0, Math.min(99, Math.min(rawY1, rawY2)));
      const x2 = Math.max(x1 + 1, Math.min(100, Math.max(rawX1, rawX2)));
      const y2 = Math.max(y1 + 1, Math.min(100, Math.max(rawY1, rawY2)));
      const w = Math.max(1, x2 - x1);
      const h = Math.max(1, y2 - y1);
      const box = document.createElement("div");
      box.className = "calm-md-box";
      box.textContent = item.text;
      box.style.left = `${x1}%`;
      box.style.top = `${y1}%`;
      box.style.width = `${w}%`;
      box.style.height = `${h}%`;
      overlay.append(box);
      fitBoxText(box, fontSizeForBox(overlay, h));
    }
  }

  function repositionAll() {
    for (const img of getReaderImages()) {
      const state = STATE.get(img);
      if (state?.overlay) {
        positionOverlay(img, state.overlay);
      }
    }
  }

  async function translateImage(img) {
    const state = ensureOverlay(img);
    if (state.status === "done" || state.status === "loading") {
      return;
    }
    state.status = "loading";
    setStatus("MangaDex: translating");

    let imageDataUrl;
    try {
      imageDataUrl = imageToDataUrl(img);
    } catch (error) {
      state.status = "error";
      setStatus("MangaDex: image blocked", "error");
      return;
    }

    const response = await chrome.runtime.sendMessage({
      scope: "calm-mangadex",
      type: "translateImage",
      imageDataUrl,
    });

    if (!response?.ok) {
      state.status = "error";
      const message = response?.error === "missing_api_key"
        ? "MangaDex: add API key"
        : "MangaDex: translation failed";
      setStatus(message, "error");
      return;
    }

    renderOverlay(img, response.result);
    state.status = "done";
    const count = response.result?.items?.length || 0;
    setStatus(count ? `MangaDex: ${count} translated` : "MangaDex: no text found");
  }

  async function translateVisible() {
    if (!enabled || busy || !isChapterPage()) {
      return;
    }
    const img = getReaderImages().find((candidate) => {
      const state = STATE.get(candidate);
      return isVisibleImage(candidate) && state?.status !== "done";
    });
    if (!img) {
      repositionAll();
      return;
    }
    busy = true;
    try {
      await translateImage(img);
    } finally {
      busy = false;
    }
  }

  function scheduleTranslate() {
    window.clearTimeout(scheduleTranslate.timer);
    scheduleTranslate.timer = window.setTimeout(() => {
      void translateVisible();
    }, 180);
  }

  async function init() {
    initTranslatePdfButton();

    const settings = await chrome.storage.local.get({
      mangadexTranslateEnabled: false,
    });
    enabled = !!settings.mangadexTranslateEnabled;
    if (!enabled || !isChapterPage()) {
      return;
    }

    setStatus("MangaDex: ready");
    scheduleTranslate();
    addEventListener("scroll", scheduleTranslate, { passive: true });
    addEventListener("resize", repositionAll, { passive: true });
    new MutationObserver(scheduleTranslate).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "style", "class"],
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.mangadexTranslateEnabled) {
      return;
    }
    enabled = !!changes.mangadexTranslateEnabled.newValue;
    if (enabled) {
      void init();
    } else {
      setStatus("MangaDex: off");
      for (const img of getReaderImages()) {
        const state = STATE.get(img);
        state?.overlay?.remove();
        STATE.delete(img);
      }
    }
  });

  void init();
})();
