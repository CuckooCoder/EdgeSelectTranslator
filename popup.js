const toggle = document.querySelector("#toggle");
const title = document.querySelector("#state-title");
const description = document.querySelector("#state-description");
const provider = document.querySelector("#provider");
let enabled = true;

function render() {
  toggle.setAttribute("aria-pressed", String(enabled));
  title.textContent = enabled ? "翻译已开启" : "翻译已关闭";
  description.textContent = enabled ? "在网页中选中文字即可自动翻译" : "网页中的翻译功能已暂停";
}

chrome.storage.local.get({ enabled: true }, (settings) => {
  enabled = settings.enabled !== false;
  render();
});

chrome.storage.local.get({ provider: "sogou" }, (settings) => {
  provider.value = ["google", "sogou", "youdao"].includes(settings.provider) ? settings.provider : "sogou";
  render();
});

toggle.addEventListener("click", () => {
  enabled = !enabled;
  render();
  chrome.storage.local.set({ enabled });
});

provider.addEventListener("change", () => {
  chrome.storage.local.set({ provider: provider.value });
  render();
});
