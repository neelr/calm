const DEFAULT_MODEL = "gpt-5.5";
const IMAGE_MODEL = "gpt-image-1.5";
const MAX_CONTEXT_CHARS = 12000;
let localConfigPromise;

async function getLocalConfig() {
  if (!localConfigPromise) {
    localConfigPromise = fetch(chrome.runtime.getURL("mangadex/local-config.json"))
      .then((response) => response.ok ? response.json() : {})
      .catch(() => ({}));
  }
  return localConfigPromise;
}

function extractResponseText(data) {
  if (typeof data?.output_text === "string") {
    return data.output_text;
  }
  for (const item of data?.output || []) {
    if (item?.type !== "message") {
      continue;
    }
    for (const part of item.content || []) {
      if (typeof part?.text === "string") {
        return part.text;
      }
    }
  }
  return "";
}

function parseJson(text) {
  const trimmed = String(text || "").trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(unfenced);
}

function normalizeTranslation(data) {
  const rawItems = Array.isArray(data?.items) ? data.items : [];
  const items = rawItems
    .map((item) => {
      const text = String(item.text || "").trim();
      const rawX1 = Number(item.x1);
      const rawY1 = Number(item.y1);
      const rawX2 = Number(item.x2);
      const rawY2 = Number(item.y2);
      const x1 = Math.max(0, Math.min(99, Math.min(rawX1, rawX2)));
      const y1 = Math.max(0, Math.min(99, Math.min(rawY1, rawY2)));
      const x2 = Math.max(x1 + 1, Math.min(100, Math.max(rawX1, rawX2)));
      const y2 = Math.max(y1 + 1, Math.min(100, Math.max(rawY1, rawY2)));
      return { x1, y1, x2, y2, text };
    })
    .filter((item) =>
      Number.isFinite(item.x1) &&
      Number.isFinite(item.y1) &&
      Number.isFinite(item.x2) &&
      Number.isFinite(item.y2) &&
      item.x2 > item.x1 &&
      item.y2 > item.y1 &&
      item.text
    )
    .slice(0, 80);
  return {
    items,
    sourceLanguage: data?.sourceLanguage || data?.source_language || "",
  };
}

async function getMangadexSettings() {
  const settings = await chrome.storage.local.get({
    mangadexOpenAiApiKey: "",
    mangadexTargetLanguage: "English",
    mangadexPromptContext: "",
  });
  const localConfig = await getLocalConfig();
  const apiKey = (
    settings.mangadexOpenAiApiKey ||
    localConfig.openAiApiKey ||
    ""
  ).trim();
  if (!apiKey) {
    throw new Error("missing_api_key");
  }

  const targetLanguage = settings.mangadexTargetLanguage.trim() || "English";
  const promptContext = settings.mangadexPromptContext
    .trim()
    .slice(0, MAX_CONTEXT_CHARS);
  return { apiKey, targetLanguage, promptContext };
}

function contextPrompt(promptContext) {
  return promptContext
    ? `User-provided context/vocabulary/reference:\n${promptContext}\n\nUse this context to keep names, terms, era references, and phrasing consistent.`
    : "";
}

async function translateImage({ imageDataUrl }) {
  let settings;
  try {
    settings = await getMangadexSettings();
  } catch (error) {
    return { ok: false, error: error.message };
  }

  const prompt = [
    contextPrompt(settings.promptContext),
    "OCR and translate the manga/comic text in this page image.",
    `Translate into ${settings.targetLanguage}.`,
    "The image includes a faint red 0-100 coordinate grid added by the browser extension.",
    "Ignore the red grid lines and red numbers for OCR; they are not part of the manga.",
    "Use the red grid only to estimate coordinates precisely.",
    "Use x1, y1, x2, y2 as percentages of the whole image from 0 to 100.",
    "x1/y1 is the top-left corner of the original text region; x2/y2 is the bottom-right corner.",
    "Every box must stay fully inside the image: 0 <= x1 < x2 <= 100 and 0 <= y1 < y2 <= 100.",
    "Group each speech bubble or caption into one concise translated item.",
    "Do not include sound effects unless they matter for understanding.",
  ].join(" ");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      reasoning: { effort: "none" },
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "mangadex_translation",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["items", "sourceLanguage"],
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["x1", "y1", "x2", "y2", "text"],
                  properties: {
                    x1: { type: "number" },
                    y1: { type: "number" },
                    x2: { type: "number" },
                    y2: { type: "number" },
                    text: { type: "string" },
                  },
                },
              },
              sourceLanguage: { type: "string" },
            },
          },
        },
      },
      max_output_tokens: 2500,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: imageDataUrl },
          ],
        },
      ],
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      error: body?.error?.message || `OpenAI request failed (${response.status})`,
    };
  }

  let result;
  try {
    result = normalizeTranslation(parseJson(extractResponseText(body)));
  } catch (error) {
    return { ok: false, error: `Could not parse translation JSON: ${error.message}` };
  }

  return { ok: true, result };
}

function dataUrlToBlob(dataUrl) {
  const [header, data] = String(dataUrl).split(",");
  const match = header.match(/^data:([^;]+);base64$/);
  if (!match || !data) {
    throw new Error("Invalid image data");
  }
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: match[1] });
}

async function translatePageImage({ imageDataUrl, pageNumber, pageCount }) {
  let settings;
  try {
    settings = await getMangadexSettings();
  } catch (error) {
    return { ok: false, error: error.message };
  }

  const prompt = [
    contextPrompt(settings.promptContext),
    "Edit this manga page into an English translated page.",
    `Translate all readable dialogue, captions, title text, and important signs into ${settings.targetLanguage}.`,
    "Preserve the original manga art, panels, faces, composition, page size, black-and-white look, and reading flow.",
    "Replace the original text in-place with clean manga lettering.",
    "Use Anime Ace 2.0 BB / Anime Ace BB style lettering: uppercase-friendly, bold comic manga text, centered in bubbles and captions.",
    "Keep the translated text fully visible inside the original text areas. Shrink and wrap text as needed.",
    "Do not summarize. Do not add new art. Do not add watermarks or commentary.",
    pageNumber && pageCount ? `This is page ${pageNumber} of ${pageCount}.` : "",
  ].join("\n\n");

  const form = new FormData();
  form.append("model", IMAGE_MODEL);
  form.append("prompt", prompt);
  form.append("image", dataUrlToBlob(imageDataUrl), "mangadex-page.jpg");
  form.append("input_fidelity", "high");
  form.append("output_format", "jpeg");
  form.append("output_compression", "92");
  form.append("n", "1");

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${settings.apiKey}`,
    },
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      error: body?.error?.message || `OpenAI image edit failed (${response.status})`,
    };
  }
  const imageBase64 = body?.data?.[0]?.b64_json;
  if (!imageBase64) {
    return { ok: false, error: "OpenAI returned no image" };
  }
  return { ok: true, imageDataUrl: `data:image/jpeg;base64,${imageBase64}` };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.scope !== "calm-mangadex") {
    return false;
  }
  if (message.type === "translateImage") {
    translateImage(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message.type === "translatePageImage") {
    translatePageImage(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return false;
});
