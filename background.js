const GOOGLE_TRANSLATE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const PROVIDERS = { google: "Google 翻译", sogou: "搜狗翻译", youdao: "有道翻译" };
const SOGOU_TRANSLATE_ENDPOINT = "https://fanyi.sogou.com/api/transpc/hunyuan/translate";
const YOUDAO_TRANSLATE_ENDPOINT = "https://m.youdao.com/translate";
const REQUEST_TIMEOUT_MS = 12000;
const GOOGLE_MAX_REQUEST_BYTES = 16 * 1024;
const SOGOU_MAX_REQUEST_BYTES = 16 * 1024;
const YOUDAO_MAX_FORM_BYTES = 640;
const SOGOU_LANGUAGES = new Set(["zh-CN", "en", "ja", "ko"]);
const YOUDAO_LANGUAGES = new Map([
  ["zh-CN", "ZH_CN"],
  ["en", "EN"],
  ["ja", "JA"],
  ["ko", "KR"],
  ["fr", "FR"],
  ["ru", "RU"],
  ["es", "SP"]
]);

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
  const source = normalizeLanguage(requestedSource, true);
  const target = normalizeLanguage(requestedTarget, false);
  const provider = normalizeProvider(requestedProvider);
  if (provider === "youdao") return translateWithYoudao(text, source, target);
  if (source !== "auto" && source === target) {
    return { translated: text, detectedLanguage: source, target, provider };
  }
  if (provider === "sogou") return translateWithSogou(text, source, target);
  return translateWithGoogle(text, source, target);
}

function normalizeProvider(value) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value) ? value : "sogou";
}

function youdaoRequestType(text, requestedSource, target) {
  const source = requestedSource === "auto" ? inferSourceLanguage(text) : requestedSource;
  if (source === target) return { type: "", source };

  if (requestedSource === "auto" && target === "zh-CN" && source !== "zh-CN") {
    return { type: "auto", source };
  }

  const sourceCode = YOUDAO_LANGUAGES.get(source);
  const targetCode = YOUDAO_LANGUAGES.get(target);
  if (!sourceCode || !targetCode || (source !== "zh-CN" && target !== "zh-CN")) {
    throw new Error("有道网页接口目前只支持中文与英语、日语、韩语、法语、俄语、西班牙语互译；请切换翻译服务。");
  }
  return { type: `${sourceCode}2${targetCode}`, source };
}

function makeYoudaoForm(text, requestedSource, target) {
  const { type, source } = youdaoRequestType(text, requestedSource, target);
  if (!type) return { body: null, source };
  const body = new URLSearchParams({ inputtext: text, type });
  const byteLength = new TextEncoder().encode(body.toString()).length;
  if (byteLength > YOUDAO_MAX_FORM_BYTES) {
    throw new Error(`有道单次请求超过 ${YOUDAO_MAX_FORM_BYTES} 字节（当前 ${byteLength} 字节），请缩短文本或切换翻译服务。`);
  }
  return { body, source };
}

async function translateWithYoudao(text, requestedSource, target) {
  const initial = youdaoRequestType(text, requestedSource, target);
  if (!initial.type) return { translated: text, detectedLanguage: initial.source, target, provider: "youdao" };

  const { body, source } = makeYoudaoForm(text, requestedSource, target);
  if (!body) return { translated: text, detectedLanguage: source, target, provider: "youdao" };
  const response = await fetchWithTimeout(YOUDAO_TRANSLATE_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    credentials: "omit",
    referrer: YOUDAO_TRANSLATE_ENDPOINT,
    referrerPolicy: "strict-origin-when-cross-origin",
    body
  });
  if (response.status === 413) {
    throw new Error(`有道单次请求超过 ${YOUDAO_MAX_FORM_BYTES} 字节表单上限，请缩短选区后重试。`);
  }
  if (!response.ok) throw new Error(`有道翻译请求失败（HTTP ${response.status}）。`);

  const html = await response.text();
  const result = parseYoudaoResult(html);
  if (!result) throw new Error("有道翻译未返回译文，请尝试切换翻译服务。");
  return { translated: result, detectedLanguage: source, target, provider: "youdao" };
}

function parseYoudaoResult(html) {
  const list = String(html).match(/<ul\b[^>]*id=["']translateResult["'][^>]*>([\s\S]*?)<\/ul>/i)?.[1];
  if (!list) return "";
  const items = [...list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((match) => decodeHtmlEntities(match[1]
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]*>/g, "")).trim())
    .filter(Boolean);
  return items.join("\n");
}

function decodeHtmlEntities(text) {
  const named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", mdash: "—", ndash: "–"
  };
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, value) => {
    if (value[0] === "#") {
      const hex = value[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(value.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return named[value.toLowerCase()] ?? entity;
  });
}

function normalizeLanguage(value, allowAuto) {
  const code = String(value || "").trim();
  if (allowAuto && code === "auto") return code;
  if (!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/.test(code)) return allowAuto ? "auto" : "zh-CN";
  return code;
}

async function translateWithGoogle(text, source, target) {
  const params = new URLSearchParams({ client: "gtx", sl: source, tl: target, dt: "t", q: text });
  const url = `${GOOGLE_TRANSLATE_ENDPOINT}?${params}`;
  const requestBytes = new TextEncoder().encode(url).length;
  if (requestBytes > GOOGLE_MAX_REQUEST_BYTES) {
    throw new Error(`Google 翻译单次请求超过 ${GOOGLE_MAX_REQUEST_BYTES} 字节（当前 ${requestBytes} 字节），请缩短选区后重试。`);
  }

  const response = await fetchWithTimeout(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Google 翻译请求失败（HTTP ${response.status}）。`);
  const payload = await response.json();
  const translated = Array.isArray(payload?.[0])
    ? payload[0].map((part) => part?.[0] || "").join("")
    : "";
  if (!translated) throw new Error("Google 翻译接口没有返回译文。");
  return { translated, detectedLanguage: payload?.[2] || "", target, provider: "google" };
}

async function translateWithSogou(text, requestedSource, target) {
  const source = requestedSource === "auto" ? inferSourceLanguage(text) : requestedSource;
  if (!SOGOU_LANGUAGES.has(source) || !SOGOU_LANGUAGES.has(target) || (source !== "zh-CN" && target !== "zh-CN")) {
    throw new Error("搜狗网页接口目前仅支持简体中文与英语、日语、韩语互译；请切换到 Google 翻译。");
  }

  const sourceCode = source === "zh-CN" ? "zh-CHS" : source;
  const targetCode = target === "zh-CN" ? "zh-CHS" : target;
  const body = JSON.stringify({ text, from_lang: sourceCode, to_lang: targetCode });
  const requestBytes = new TextEncoder().encode(body).length;
  if (requestBytes > SOGOU_MAX_REQUEST_BYTES) {
    throw new Error(`搜狗翻译单次请求超过 ${SOGOU_MAX_REQUEST_BYTES} 字节（当前 ${requestBytes} 字节），请缩短选区后重试。`);
  }

  const response = await fetchWithTimeout(SOGOU_TRANSLATE_ENDPOINT, {
    method: "POST",
    cache: "no-store",
    credentials: "omit",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body
  });
  if (!response.ok) throw new Error(`搜狗翻译请求失败（HTTP ${response.status}）。`);
  const payload = await response.json();
  if (Number(payload?.status) !== 0 || Number(payload?.data?.code) !== 0 || !payload?.data?.content) {
    const detail = payload?.data?.message || payload?.message || "接口没有返回译文";
    throw new Error(`搜狗翻译：${detail}。`);
  }
  return { translated: payload.data.content, detectedLanguage: source, target, provider: "sogou" };
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
