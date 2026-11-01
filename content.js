(() => {
  const HOST_ID = "edge-bilingual-translator-host";
  const MAX_CHARS = 5000;
  const PROVIDER_NAMES = { google: "Google 翻译", mymemory: "MyMemory", sogou: "搜狗翻译" };
  const AVAILABLE_LANGUAGES = globalThis.TRANSLATION_LANGUAGES || [
    { code: "zh-CN", label: "中文（简体）" },
    { code: "zh-TW", label: "中文（繁体）" },
    { code: "en", label: "英语" },
    { code: "ja", label: "日语" },
    { code: "ko", label: "韩语" },
    { code: "fr", label: "法语" },
    { code: "de", label: "德语" },
    { code: "es", label: "西班牙语" },
    { code: "ru", label: "俄语" }
  ];
  // Keep Chinese variants handy, then prioritize major study destinations
  // by recent published Chinese-student counts. English aggregates destinations
  // such as the US, UK, Australia, and Canada. Other languages retain Google's order.
  const LANGUAGE_PRIORITY = new Map([
    "zh-CN", "zh-TW", "en", "ja", "ko", "ru", "fr", "fr-CA", "de", "th"
  ].map((code, index) => [code, index]));
  const LANGUAGES = AVAILABLE_LANGUAGES
    .map((language, index) => ({ language, index }))
    .sort((a, b) => {
      const rankA = LANGUAGE_PRIORITY.get(a.language.code) ?? Number.MAX_SAFE_INTEGER;
      const rankB = LANGUAGE_PRIORITY.get(b.language.code) ?? Number.MAX_SAFE_INTEGER;
      return rankA - rankB || a.index - b.index;
    })
    .map(({ language }) => language);
  const LANGUAGE_NAMES = new Map(LANGUAGES.map(({ code, label }) => [code, label]));

  let host;
  let shadow;
  let currentText = "";
  let currentTranslation = "";
  let sourceLanguage = "auto";
  let targetLanguage = "zh-CN";
  let detectedSourceLanguage = "";
  let targetManuallySelected = false;
  let currentProvider = "sogou";
  let requestNumber = 0;
  let requestTimeout;
  let hideTimer;
  let enabled = true;

  chrome.storage.local.get({ enabled: true, provider: "sogou" }, (settings) => {
    enabled = settings.enabled !== false;
    currentProvider = normalizeProvider(settings.provider);
    if (!enabled) hideCard();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.enabled) {
      enabled = changes.enabled.newValue !== false;
      if (!enabled) hideCard();
    }
    if (changes.provider) {
      currentProvider = normalizeProvider(changes.provider.newValue);
      updateProviderLabel();
      if (currentText && host?.style.display !== "none") translateCurrent();
    }
  });

  function normalizeProvider(value) {
    return Object.prototype.hasOwnProperty.call(PROVIDER_NAMES, value) ? value : "sogou";
  }

  function likelyLanguage(text) {
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

  function defaultTarget(text, source = "auto") {
    const language = source === "auto" ? likelyLanguage(text) : source;
    return language === "zh-CN" || language === "zh-TW" ? "en" : "zh-CN";
  }

  function makeCard() {
    if (host) return;
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;left:0;top:0;display:none;";
    shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .card {
          box-sizing: border-box; width: min(420px, calc(100vw - 24px)); max-height: min(460px, calc(100vh - 24px));
          overflow: auto; padding: 14px; border: 1px solid #e5e7eb; border-radius: 14px;
          background: #fff; color: #202124; box-shadow: 0 12px 36px rgba(20, 30, 55, .2);
          font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; }
        .brand { font-weight:700; font-size:13px; color:#4b5563; letter-spacing:.2px; }
        .actions { display:flex; gap:6px; align-items:center; }
        button { font:inherit; cursor:pointer; border:0; }
        .tool { border-radius:8px; background:#f3f4f6; color:#374151; padding:5px 8px; font-size:12px; }
        .tool:hover { background:#e8eaed; }
        .tool:disabled { cursor:default; opacity:.45; }
        .close { width:26px; height:26px; border-radius:8px; background:transparent; color:#6b7280; font-size:18px; line-height:1; }
        .close:hover { background:#f3f4f6; }
        .language-row { display:grid; grid-template-columns:minmax(0,1fr) 32px minmax(0,1fr); gap:7px; margin:0 0 12px; }
        select { min-width:0; width:100%; padding:7px 8px; border:1px solid #d1d5db; border-radius:8px; color:#202124; background:#fff; font:inherit; font-size:12px; }
        .swap { border:1px solid #e5e7eb; border-radius:8px; background:#f9fafb; color:#4b5563; font-size:18px; line-height:1; }
        .swap:hover { background:#f3f4f6; }
        .label { color:#6b7280; font-size:11px; text-transform:uppercase; letter-spacing:.06em; margin:9px 0 3px; }
        .original { color:#4b5563; white-space:pre-wrap; overflow-wrap:anywhere; max-height:84px; overflow:auto; }
        .result { font-size:15px; white-space:pre-wrap; overflow-wrap:anywhere; }
        .status { color:#6b7280; }
        .error { color:#b42318; }
        .foot { margin-top:10px; display:flex; justify-content:space-between; align-items:center; gap:8px; }
        .hint { color:#9ca3af; font-size:11px; }
        @media (prefers-color-scheme: dark) {
          .card { background:#202124; color:#e8eaed; border-color:#3c4043; box-shadow:0 12px 36px rgba(0,0,0,.42); }
          .brand,.original { color:#bdc1c6; } .label,.status,.hint { color:#9aa0a6; }
          .tool,.swap { background:#303134; color:#e8eaed; border-color:#3c4043; }
          .tool:hover,.swap:hover,.close:hover { background:#3c4043; }
          .close { color:#bdc1c6; }
          select { background:#303134; color:#e8eaed; border-color:#5f6368; }
        }
      </style>
      <section class="card" role="status" aria-live="polite">
        <div class="head">
          <span class="brand">划词翻译(免费)</span>
          <div class="actions">
            <button class="tool copy" type="button" title="复制译文">复制</button>
            <button class="close" type="button" title="关闭" aria-label="关闭">×</button>
          </div>
        </div>
        <div class="language-row">
          <select class="source-language" aria-label="源语言" title="源语言"></select>
          <button class="swap" type="button" title="交换源语言和目标语言" aria-label="交换源语言和目标语言">⇄</button>
          <select class="target-language" aria-label="目标语言" title="目标语言"></select>
        </div>
        <div class="label">原文</div><div class="original"></div>
        <div class="label">译文</div><div class="result status">正在翻译…</div>
        <div class="foot"><span class="hint provider-label"></span><span class="hint language"></span></div>
      </section>`;

    document.documentElement.appendChild(host);
    const sourceSelect = shadow.querySelector(".source-language");
    const targetSelect = shadow.querySelector(".target-language");
    populateLanguageSelect(sourceSelect, true);
    populateLanguageSelect(targetSelect, false);
    shadow.querySelector(".close").addEventListener("click", hideCard);
    shadow.querySelector(".swap").addEventListener("click", swapLanguages);
    shadow.querySelector(".copy").addEventListener("click", copyTranslation);
    sourceSelect.addEventListener("change", () => {
      sourceLanguage = sourceSelect.value;
      if (!targetManuallySelected) {
        targetLanguage = defaultTarget(currentText, sourceLanguage);
        targetSelect.value = targetLanguage;
      }
      translateCurrent();
    });
    targetSelect.addEventListener("change", () => {
      targetLanguage = targetSelect.value;
      targetManuallySelected = true;
      translateCurrent();
    });
    updateProviderLabel();
    host.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    host.addEventListener("mouseleave", scheduleHideIfSelectionGone);
  }

  function populateLanguageSelect(select, includeAuto) {
    const fragment = document.createDocumentFragment();
    if (includeAuto) {
      const automatic = document.createElement("option");
      automatic.value = "auto";
      automatic.textContent = "自动检测";
      fragment.appendChild(automatic);
    }
    for (const language of LANGUAGES) {
      const option = document.createElement("option");
      option.value = language.code;
      option.textContent = language.label;
      fragment.appendChild(option);
    }
    select.appendChild(fragment);
  }

  function selectionBox(selection) {
    if (!selection?.rangeCount) return null;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (rect.width || rect.height) return rect;
    return null;
  }

  function positionCard(rect) {
    const margin = 12;
    const width = Math.min(420, window.innerWidth - margin * 2);
    const estimatedHeight = Math.min(360, window.innerHeight - margin * 2);
    let left = rect.left + Math.max(0, (rect.width - width) / 2);
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    let top = rect.bottom + 10;
    if (top + estimatedHeight > window.innerHeight - margin) top = rect.top - estimatedHeight - 10;
    top = Math.max(margin, Math.min(top, window.innerHeight - estimatedHeight - margin));
    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(top)}px`;
  }

  function selectionIsInsideCard(selection) {
    if (!shadow || !selection) return false;
    return [selection.anchorNode, selection.focusNode].some((node) => node?.getRootNode() === shadow);
  }

  function exceedsCharacterLimit(text, limit) {
    let count = 0;
    for (const _character of text) {
      if (++count > limit) return true;
    }
    return false;
  }

  function translateSelectionNow() {
    if (!enabled) return;
    const selection = window.getSelection();
    if (selectionIsInsideCard(selection)) return;
    const text = String(selection?.toString() || "").trim();
    if (!text) return;
    if (host?.style.display !== "none" && text === currentText) return;
    showSelection(text);
  }

  function showSelection(selectedText) {
    if (!enabled) return;
    clearTimeout(hideTimer);
    const selection = window.getSelection();
    const text = String(selectedText || selection?.toString() || "").trim();
    const selectionRect = selectionBox(selection);
    const rect = selectionRect || {
      left: window.innerWidth / 2,
      right: window.innerWidth / 2,
      top: window.innerHeight / 2,
      bottom: window.innerHeight / 2,
      width: 0,
      height: 0
    };
    if (!text) return;

    makeCard();
    currentText = text;
    currentTranslation = "";
    sourceLanguage = "auto";
    targetLanguage = defaultTarget(text);
    detectedSourceLanguage = "";
    targetManuallySelected = false;
    currentProvider = normalizeProvider(currentProvider);
    positionCard(rect);
    host.style.display = "block";
    shadow.querySelector(".original").textContent = text;
    shadow.querySelector(".source-language").value = sourceLanguage;
    shadow.querySelector(".target-language").value = targetLanguage;
    shadow.querySelector(".language").textContent = "";
    shadow.querySelector(".swap").disabled = true;
    updateProviderLabel();
    if (exceedsCharacterLimit(text, MAX_CHARS)) {
      showError("选中文本超过 5000 字，本次未发送翻译请求。请缩短选区后重试。");
      return;
    }
    translateCurrent();
  }

  function updateProviderLabel() {
    if (!shadow) return;
    const label = shadow.querySelector(".provider-label");
    if (label) label.textContent = `${PROVIDER_NAMES[currentProvider] || PROVIDER_NAMES.auto} · 最多 5000 字`;
  }

  function translateCurrent() {
    const requestId = ++requestNumber;
    clearTimeout(requestTimeout);
    currentTranslation = "";
    updateProviderLabel();
    shadow.querySelector(".swap").disabled = true;
    const result = shadow.querySelector(".result");
    result.textContent = "正在翻译…";
    result.className = "result status";
    shadow.querySelector(".language").textContent = "";
    requestTimeout = setTimeout(() => {
      if (requestId === requestNumber && host && host.style.display !== "none") {
        showError("翻译请求超时，请重新加载扩展后重试。");
      }
    }, 25000);

    chrome.runtime.sendMessage(
      {
        type: "translate-selection",
        text: currentText,
        source: sourceLanguage,
        target: targetLanguage,
        provider: currentProvider
      },
      (response) => {
        clearTimeout(requestTimeout);
        if (requestId !== requestNumber || !host || host.style.display === "none") return;
        if (chrome.runtime.lastError) {
          showError("翻译服务未响应，请重新选中文字。");
          return;
        }
        if (!response || response.error) {
          showError(response?.error || "翻译失败，请稍后重试。");
          return;
        }
        currentTranslation = response.translated;
        currentProvider = normalizeProvider(response.provider || currentProvider);
        updateProviderLabel();
        detectedSourceLanguage = response.detectedLanguage || (sourceLanguage === "auto" ? likelyLanguage(currentText) : sourceLanguage);
        result.textContent = response.translated;
        result.className = "result";
        shadow.querySelector(".swap").disabled = !currentTranslation;
        const detectedLabel = getLanguageLabel(detectedSourceLanguage);
        shadow.querySelector(".language").textContent = detectedLabel ? `检测到：${detectedLabel}` : "";
      }
    );
  }

  function swapLanguages() {
    if (!currentTranslation) return;
    const nextText = currentTranslation;
    const effectiveSource = sourceLanguage === "auto"
      ? detectedSourceLanguage || likelyLanguage(currentText)
      : sourceLanguage;
    const nextSource = targetLanguage;
    let nextTarget = effectiveSource || "en";
    if (nextTarget === nextSource) nextTarget = nextSource === "zh-CN" ? "en" : "zh-CN";

    currentText = nextText;
    currentTranslation = "";
    sourceLanguage = nextSource;
    targetLanguage = nextTarget;
    detectedSourceLanguage = "";
    targetManuallySelected = true;
    shadow.querySelector(".original").textContent = currentText;
    shadow.querySelector(".source-language").value = sourceLanguage;
    shadow.querySelector(".target-language").value = targetLanguage;
    translateCurrent();
  }

  function getLanguageLabel(code) {
    if (!code) return "";
    const normalizedCode = code === "zh-CHS" ? "zh-CN" : code;
    return LANGUAGE_NAMES.get(normalizedCode) || LANGUAGE_NAMES.get(normalizedCode.split("-")[0]) || code;
  }

  function showError(message) {
    currentTranslation = "";
    if (shadow) shadow.querySelector(".swap").disabled = true;
    const result = shadow.querySelector(".result");
    result.textContent = message;
    result.className = "result error";
  }

  async function copyTranslation() {
    const result = shadow.querySelector(".result");
    const text = result?.classList.contains("status") || result?.classList.contains("error")
      ? ""
      : result?.textContent || "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      shadow.querySelector(".copy").textContent = "已复制";
      setTimeout(() => {
        if (host && shadow.querySelector(".copy")) shadow.querySelector(".copy").textContent = "复制";
      }, 1200);
    } catch {
      showError("无法访问剪贴板，请手动复制译文。");
    }
  }

  function hideCard() {
    clearTimeout(hideTimer);
    clearTimeout(requestTimeout);
    if (host) host.style.display = "none";
    currentText = "";
    currentTranslation = "";
    requestNumber++;
  }

  function scheduleHideIfSelectionGone() {
    hideTimer = setTimeout(() => {
      if (!window.getSelection()?.toString().trim()) hideCard();
    }, 350);
  }

  // Translate once the selection gesture ends, instead of while the range is changing.
  document.addEventListener("pointerup", translateSelectionNow);
  document.addEventListener("mouseup", translateSelectionNow);
  document.addEventListener("touchend", translateSelectionNow);
  document.addEventListener("keyup", (event) => {
    if (event.key === "Shift" || !event.shiftKey) translateSelectionNow();
  });

  document.addEventListener("pointerdown", (event) => {
    if (!host || host.style.display === "none") return;
    if (event.composedPath().includes(host)) return;
    if (window.getSelection()?.toString().trim()) hideCard();
  }, true);

  window.addEventListener("scroll", () => {
    if (host && host.style.display !== "none") hideCard();
  }, true);
})();
