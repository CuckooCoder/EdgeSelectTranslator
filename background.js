const GOOGLE_TRANSLATE_ENDPOINTS = [
  "https://translate.googleapis.com/translate_a/single",
  "https://translate.google.com/translate_a/single"
];
const PROVIDERS = { google: "Google 翻译", mymemory: "MyMemory", sogou: "搜狗翻译" };
const MYMEMORY_ENDPOINT = "https://api.mymemory.translated.net/get";
const SOGOU_TRANSLATE_ENDPOINT = "https://fanyi.sogou.com/api/transpc/hunyuan/translate";
const REQUEST_TIMEOUT_MS = 12000;
const MAX_CHARS = 5000;
const SOGOU_LANGUAGES = new Set(["zh-CN", "en", "ja", "ko"]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "translate-selection") return undefined;

  translate(message.text, message.source, message.target, message.provider)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ error: error.message || "翻译失败，请稍后重试。" }));

  return true;
});

async function translate(input, requestedSource, requestedTarget, requestedProvider) {
  const text = String(input || "").trim();
  if (!text) throw new Error("没有可翻译的文字。");
  if (exceedsCharacterLimit(text, MAX_CHARS)) {
    throw new Error("选中文本超过 5000 字，本次未发送翻译请求。请缩短选区后重试。");
  }

  const source = normalizeLanguage(requestedSource, true);
  const target = normalizeLanguage(requestedTarget, false);
  const provider = normalizeProvider(requestedProvider);
  if (source !== "auto" && source === target) {
    return { translated: text, detectedLanguage: source, target, provider };
  }
  if (provider === "mymemory") return translateWithMyMemory(text, source, target);
  if (provider === "sogou") return translateWithSogou(text, source, target);
  return translateWithGoogle(text, source, target);
}

function normalizeProvider(value) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value) ? value : "sogou";
}

function exceedsCharacterLimit(text, limit) {
  let count = 0;
  for (const _character of text) {
    if (++count > limit) return true;
  }
  return false;
}

function normalizeLanguage(value, allowAuto) {
  const code = String(value || "").trim();
  if (allowAuto && code === "auto") return code;
  if (!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/.test(code)) return allowAuto ? "auto" : "zh-CN";
  return code;
}

async function translateWithGoogle(text, source, target) {
  const params = new URLSearchParams({
    client: "gtx",
    sl: source,
    tl: target,
    dt: "t",
    q: text
  });
  const errors = [];
  for (const endpoint of GOOGLE_TRANSLATE_ENDPOINTS) {
    try {
      const response = await fetchWithTimeout(`${endpoint}?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = await response.json();
      const translated = Array.isArray(payload?.[0])
        ? payload[0].map((part) => part?.[0] || "").join("")
        : "";
      if (!translated) throw new Error("返回内容中没有译文");

      return {
        translated,
        detectedLanguage: payload?.[2] || "",
        target,
        provider: "google"
      };
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(`Google 翻译接口未能响应（${errors.join("；")}）。请稍后重试。`);
}

async function translateWithMyMemory(text, requestedSource, target) {
  const source = requestedSource === "auto" ? inferSourceLanguage(text) : requestedSource;
  const chunks = splitUtf8(text, 450);
  const translatedChunks = [];

  for (const chunk of chunks) {
    const params = new URLSearchParams({ q: chunk, langpair: `${source}|${target}` });
    const response = await fetchWithTimeout(`${MYMEMORY_ENDPOINT}?${params}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`MyMemory 翻译请求失败（HTTP ${response.status}）。`);
    const payload = await response.json();
    if (Number(payload?.responseStatus) !== 200 || !payload?.responseData?.translatedText) {
      const detail = payload?.quotaFinished
        ? "免费额度可能已用完"
        : payload?.responseDetails || "接口没有返回译文";
      throw new Error(`MyMemory：${detail}。`);
    }
    translatedChunks.push(decodeCommonEntities(payload.responseData.translatedText));
  }

  return {
    translated: translatedChunks.join(""),
    detectedLanguage: source,
    target,
    provider: "mymemory"
  };
}

async function translateWithSogou(text, requestedSource, target) {
  const source = requestedSource === "auto" ? inferSourceLanguage(text) : requestedSource;
  if (!SOGOU_LANGUAGES.has(source) || !SOGOU_LANGUAGES.has(target) || (source !== "zh-CN" && target !== "zh-CN")) {
    throw new Error("搜狗网页接口目前仅支持简体中文与英语、日语、韩语互译；请手动切换到 Google 翻译或 MyMemory。");
  }

  const sourceCode = source === "zh-CN" ? "zh-CHS" : source;
  const targetCode = target === "zh-CN" ? "zh-CHS" : target;
  const chunks = splitByCharacters(text, 4000);
  const translatedChunks = [];

  for (const chunk of chunks) {
    const response = await fetchWithTimeout(SOGOU_TRANSLATE_ENDPOINT, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      headers: { "Content-Type": "application/json;charset=UTF-8" },
      body: JSON.stringify({ text: chunk, from_lang: sourceCode, to_lang: targetCode })
    });
    if (!response.ok) throw new Error(`搜狗翻译请求失败（HTTP ${response.status}）。`);
    const payload = await response.json();
    if (Number(payload?.status) !== 0 || Number(payload?.data?.code) !== 0 || !payload?.data?.content) {
      const detail = payload?.data?.message || payload?.message || "接口没有返回译文";
      throw new Error(`搜狗翻译：${detail}。`);
    }
    translatedChunks.push(payload.data.content);
  }

  return {
    translated: translatedChunks.join(""),
    detectedLanguage: source,
    target,
    provider: "sogou"
  };
}

function inferSourceLanguage(text) {
  if (/[\u3040-\u30ff]/u.test(text)) return "ja";
  if (/[\uac00-\ud7af]/u.test(text)) return "ko";
  if (/[\u3400-\u9fff]/u.test(text)) return "zh-CN";
  if (/[\u0600-\u06ff]/u.test(text)) return "ar";
  if (/[\u0e00-\u0e7f]/u.test(text)) return "th";
  if (/[\u0400-\u052f]/u.test(text)) return "ru";
  if (/[\u0900-\u097f]/u.test(text)) return "hi";
  if (/[\u0590-\u05ff]/u.test(text)) return "he";
  if (/[\u0370-\u03ff]/u.test(text)) return "el";
  if (/[ãõ]/i.test(text)) return "pt";
  if (/[ñ¿¡]/i.test(text)) return "es";
  if (/[äöüß]/i.test(text)) return "de";
  if (/[àâçèêëîïôùûÿœ]/i.test(text)) return "fr";
  if (/[àèìòù]/i.test(text)) return "it";
  return "en";
}

function splitByCharacters(text, maxCharacters) {
  const characters = Array.from(text);
  const chunks = [];
  for (let index = 0; index < characters.length; index += maxCharacters) {
    chunks.push(characters.slice(index, index + maxCharacters).join(""));
  }
  return chunks;
}

function splitUtf8(text, maxBytes) {
  const encoder = new TextEncoder();
  const chunks = [];
  let chunk = "";
  let size = 0;
  for (const character of text) {
    const characterBytes = encoder.encode(character).length;
    if (chunk && size + characterBytes > maxBytes) {
      chunks.push(chunk);
      chunk = "";
      size = 0;
    }
    chunk += character;
    size += characterBytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function decodeCommonEntities(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") throw new Error("翻译请求超时，请稍后重试。");
    throw new Error(`网络请求失败：${error.message || "请检查网络后重试"}`);
  } finally {
    clearTimeout(timeout);
  }
}
