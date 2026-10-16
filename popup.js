import { displayPath } from "./lib/i18n.js";
import { DEFAULT_RULES } from "./lib/defaults.js";

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

// ---------------- 视图切换（都在同一个弹窗内） ----------------
function showView(name) {
  $("view-actions").hidden = name !== "actions";
  $("view-organize").hidden = name !== "organize";
  $("view-settings").hidden = name !== "settings";
  $("back").hidden = name === "actions";
  $("toggle-settings").classList.toggle("active", name === "settings");
  if (name === "organize") {
    refreshOrganize();
    loadArchiveList();
  }
}

$("back").addEventListener("click", () => showView("actions"));
$("toggle-settings").addEventListener("click", () => {
  showView($("view-settings").hidden ? "settings" : "actions");
});
$("organize").addEventListener("click", () => showView("organize"));

// ---------------- 操作视图 ----------------
const status = $("status");

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function pct(v) {
  return v == null ? "—" : Math.round(v * 100) + "%";
}

function render(res) {
  if (!res || !res.ok) {
    status.textContent = "错误：" + (res?.error || "未知");
    return;
  }
  if (res.openedPicker) {
    status.textContent = "已弹出选择窗口，请选择目标文件夹";
    return;
  }
  const d = res.decision || res;
  const lines = ["引擎: " + d.engine];
  if (d.analysis) lines.push("分析: " + d.analysis);
  if (d.autoSave && d.candidates?.length) {
    lines.push("直接保存: " + displayPath(d.candidates[0].folderPath) + "（" + pct(d.candidates[0].confidence) + "）");
  } else {
    lines.push("候选（会弹窗选择）：");
    (d.candidates || []).slice(0, 3).forEach((c, i) => {
      lines.push(`${i + 1}. ${displayPath(c.folderPath)} — ${pct(c.confidence)}`);
    });
    if (d.newFolder) lines.push("或新建：" + d.newFolder);
  }
  status.textContent = lines.join("\n");
}

$("dry-run").addEventListener("click", async () => {
  status.textContent = "分析中…";
  const tab = await activeTab();
  const res = await chrome.runtime.sendMessage({
    type: "classify-dry-run",
    url: tab.url,
    title: tab.title,
  });
  render(res);
});

$("save").addEventListener("click", async () => {
  status.textContent = "收藏并分类中…";
  const tab = await activeTab();
  const res = await chrome.runtime.sendMessage({
    type: "classify-and-save",
    url: tab.url,
    title: tab.title,
  });
  render(res);
});

// ---------------- 整理视图 ----------------
let orgState = { status: "idle" };
let orgPoll = null;

function setOrgPolling(on) {
  if (on && !orgPoll) {
    orgPoll = setInterval(refreshOrganize, 1500);
  } else if (!on && orgPoll) {
    clearInterval(orgPoll);
    orgPoll = null;
  }
}

async function refreshOrganize() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "organize-state" });
    if (res?.ok) {
      orgState = res.state || { status: "idle" };
      renderOrganize();
    }
  } catch {}
}

function renderOrganize() {
  const s = orgState || {};
  const running = s.status === "running";
  const total = s.total || 0;
  const done = s.done || 0;

  $("org-start").hidden = running;
  $("org-stop").hidden = !running;
  $("org-progress").hidden = !s.status || s.status === "idle";

  $("org-fill").style.width = total ? Math.min(100, Math.round((done / total) * 100)) + "%" : "0%";
  $("org-text").textContent = running
    ? `正在处理 ${Math.min(done + 1, total)}/${total}　${s.current || ""}`
    : "";

  if (s.status === "done" || s.status === "stopped" || s.status === "error") {
    $("org-summary").hidden = false;
    $("org-summary").textContent =
      s.status === "error"
        ? "出错：" + (s.error || "未知")
        : `${s.status === "stopped" ? "已停止" : "完成"}：共 ${total} 个 · 自动归位 ${s.moved || 0} · 待确认 ${s.reviewed || 0} · 跳过 ${s.skipped || 0}`;
  } else {
    $("org-summary").hidden = true;
  }

  renderOrgReview(s.review || []);
  setOrgPolling(running);
}

function renderOrgReview(items) {
  const box = $("org-review");
  box.innerHTML = "";
  if (!items.length) return;

  const title = document.createElement("div");
  title.className = "org-review-title";
  title.textContent = `需要你确认（${items.length}）`;
  box.appendChild(title);

  items.forEach((it) => {
    const el = document.createElement("div");
    el.className = "org-item";

    const head = document.createElement("div");
    head.innerHTML =
      '<div class="org-item-title">' + esc(it.title) + "</div>" +
      '<div class="org-item-sub">当前：' + esc(displayPath(it.currentPath) || "顶层") + "</div>";
    el.appendChild(head);

    const opts = document.createElement("div");
    opts.className = "org-opts";

    (it.candidates || []).slice(0, 3).forEach((c, i) => {
      const b = document.createElement("button");
      b.className = "org-opt" + (i === 0 ? " top" : "");
      b.innerHTML =
        "<span>" + esc(displayPath(c.folderPath)) + "</span>" +
        '<span class="p">' + Math.round((c.confidence || 0) * 100) + "%</span>";
      b.addEventListener("click", () => orgSend({ type: "organize-choose", bookmarkId: it.id, folderId: c.folderId }));
      opts.appendChild(b);
    });

    if (it.newFolder) {
      const nb = document.createElement("button");
      nb.className = "org-opt new";
      nb.textContent = "新建「" + it.newFolder + "」";
      nb.addEventListener("click", () => orgSend({ type: "organize-new-folder", bookmarkId: it.id, name: it.newFolder }));
      opts.appendChild(nb);
    }

    const skip = document.createElement("button");
    skip.className = "org-opt skip";
    skip.textContent = "跳过";
    skip.addEventListener("click", () => orgSend({ type: "organize-skip", bookmarkId: it.id }));
    opts.appendChild(skip);

    el.appendChild(opts);
    box.appendChild(el);
  });
}

async function orgSend(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (res?.state) {
    orgState = res.state;
    renderOrganize();
  }
}

$("org-start").addEventListener("click", async () => {
  const scope = $("org-scope").value;
  const autoMove = $("org-automove").checked;
  $("org-summary").hidden = true;
  $("org-review").innerHTML = "";
  const res = await chrome.runtime.sendMessage({ type: "organize-run", scope, autoMove });
  if (!res?.ok) {
    $("org-summary").hidden = false;
    $("org-summary").textContent = "无法开始：" + (res?.error || "未知");
    return;
  }
  await refreshOrganize();
});

$("org-stop").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "organize-stop" });
});

// ---------------- 一键归档 ----------------
let archiveArmed = false;
let archiveTimer = null;
let archiveItems = [];

async function loadArchiveList() {
  const res = await chrome.runtime.sendMessage({ type: "list-top-folders" });
  archiveItems = res?.ok && Array.isArray(res.folders) ? res.folders.slice() : [];
  const looseCount = res?.ok ? res.looseCount || 0 : 0;
  if (looseCount > 0) {
    archiveItems.push({ id: "__loose__", title: `散落书签（${looseCount}）`, count: 0, loose: true });
  }
  if (!$("archive-name").value) {
    $("archive-name").value = `旧收藏 ${new Date().getFullYear()}`;
  }
  renderArchiveList();
}

function renderArchiveList() {
  const box = $("archive-list");
  box.innerHTML = "";
  archiveItems.forEach((f) => {
    const label = document.createElement("label");
    label.className = "archive-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = f.id;
    cb.dataset.loose = f.loose ? "1" : "0";
    cb.addEventListener("change", updateArchiveCount);
    const span = document.createElement("span");
    span.textContent = f.loose ? f.title : `${f.title}（${f.count}）`;
    label.appendChild(cb);
    label.appendChild(span);
    box.appendChild(label);
  });
  updateArchiveCount();
}

function selectedArchive() {
  const cbs = $("archive-list").querySelectorAll("input[type=checkbox]");
  const folderIds = [];
  let loose = false;
  cbs.forEach((cb) => {
    if (!cb.checked) return;
    if (cb.dataset.loose === "1") loose = true;
    else folderIds.push(cb.value);
  });
  return { folderIds, loose };
}

function updateArchiveCount() {
  const { folderIds, loose } = selectedArchive();
  const n = folderIds.length + (loose ? 1 : 0);
  $("archive-count").textContent = n ? `已选 ${n} 项` : "";
  const btn = $("archive");
  if (!archiveArmed) btn.textContent = n ? `归档选中项（${n}）` : "归档选中项";
}

function resetArchiveBtn() {
  archiveArmed = false;
  $("archive").classList.remove("armed");
  updateArchiveCount();
}

$("archive-select-all").addEventListener("change", (e) => {
  $("archive-list").querySelectorAll("input[type=checkbox]").forEach((cb) => (cb.checked = e.target.checked));
  updateArchiveCount();
});

$("archive").addEventListener("click", async () => {
  const { folderIds, loose } = selectedArchive();
  if (!folderIds.length && !loose) {
    $("archive-result").hidden = false;
    $("archive-result").textContent = "请先选择要归档的文件夹";
    return;
  }
  if (!archiveArmed) {
    archiveArmed = true;
    const btn = $("archive");
    btn.textContent = "⚠️ 再点一次确认归档";
    btn.classList.add("armed");
    archiveTimer = setTimeout(resetArchiveBtn, 5000);
    return;
  }
  clearTimeout(archiveTimer);
  resetArchiveBtn();
  const name = $("archive-name").value.trim();
  const res = await chrome.runtime.sendMessage({ type: "archive-folders", folderIds, loose, archiveName: name });
  const out = $("archive-result");
  out.hidden = false;
  out.textContent = res?.ok
    ? `已归档 ${res.moved} 项到「${res.archiveName}」✓`
    : `归档失败：${res?.error || "未知"}`;
  if (res?.ok) loadArchiveList();
});

// ---------------- 批量新建文件夹 ----------------
$("create-folders").addEventListener("click", async () => {
  const names = String($("new-folders").value || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!names.length) {
    setStatus("create-folders-status", "请先填文件夹名（每行一个）");
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: "create-folders", names });
  setStatus(
    "create-folders-status",
    res?.ok ? `新建 ${res.created} 个，跳过 ${res.skipped} 个 ✓` : `失败：${res?.error || "未知"}`,
  );
});

// 进度写入 session storage，这里实时刷新（关掉弹窗也会继续跑）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || !changes.organize_progress) return;
  const wasRunning = orgState.status === "running";
  orgState = { ...orgState, ...(changes.organize_progress.newValue || {}) };
  renderOrganize();
  if (wasRunning && orgState.status !== "running") refreshOrganize();
});

// ---------------- 设置视图 ----------------
function defaults() {
  return {
    jev: { endpoint: "https://api.typesafe.ai", model: "jev-latest", apiKey: "", enabled: true },
    deepseek: { endpoint: "https://api.deepseek.com", model: "deepseek-flash", apiKey: "", enabled: true },
    pipeline: { autoMove: true, autoSaveThreshold: 0.8, debounceMs: 3000 },
    rules: [],
    excludedFolders: [],
  };
}

function serializeRules(rules) {
  return (rules || []).map((r) => `${r.type}:${r.pattern} => ${r.folderPath}`).join("\n");
}

function parseRules(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [left, right] = t.split("=>");
    if (!left || !right) continue;
    const [type, ...rest] = left.trim().split(":");
    const pattern = rest.join(":").trim();
    const folderPath = right.trim();
    if (!pattern || !folderPath) continue;
    out.push({ type: type.trim() === "domain" ? "domain" : "keyword", pattern, folderPath });
  }
  return out;
}

function clamp(v, min, max, fb) {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fb;
}

function setStatus(id, text) {
  const el = $(id);
  el.textContent = text;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.textContent = "";
  }, 3000);
}

async function loadSettings() {
  const s = await chrome.storage.local.get(null);
  const D = defaults();
  const jev = { ...D.jev, ...(s.jev || {}) };
  const deepseek = { ...D.deepseek, ...(s.deepseek || {}) };
  const pipeline = { ...D.pipeline, ...(s.pipeline || {}) };

  $("jev-enabled").checked = jev.enabled;
  $("jev-endpoint").value = jev.endpoint;
  $("jev-model").value = jev.model;
  $("jev-apikey").value = jev.apiKey;

  $("deepseek-enabled").checked = deepseek.enabled;
  $("deepseek-endpoint").value = deepseek.endpoint;
  $("deepseek-model").value = deepseek.model;
  $("deepseek-apikey").value = deepseek.apiKey;

  $("auto-move").checked = pipeline.autoMove;
  $("auto-save").value = pipeline.autoSaveThreshold;
  $("debounce").value = pipeline.debounceMs;

  $("rules").value = serializeRules(s.rules && s.rules.length ? s.rules : DEFAULT_RULES);
  $("excluded-folders").value = (Array.isArray(s.excludedFolders) ? s.excludedFolders : []).join("\n");
}

async function saveSettings() {
  const payload = {
    jev: {
      enabled: $("jev-enabled").checked,
      endpoint: $("jev-endpoint").value.trim() || "https://api.typesafe.ai",
      model: $("jev-model").value.trim() || "jev-latest",
      apiKey: $("jev-apikey").value.trim(),
    },
    deepseek: {
      enabled: $("deepseek-enabled").checked,
      endpoint: $("deepseek-endpoint").value.trim() || "https://api.deepseek.com",
      model: $("deepseek-model").value.trim() || "deepseek-flash",
      apiKey: $("deepseek-apikey").value.trim(),
    },
    pipeline: {
      autoMove: $("auto-move").checked,
      autoSaveThreshold: clamp(parseFloat($("auto-save").value), 0, 1, 0.8),
      debounceMs: Math.max(500, parseInt($("debounce").value, 10) || 3000),
    },
    rules: parseRules($("rules").value),
    excludedFolders: String($("excluded-folders").value || "")
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean),
  };
  await chrome.storage.local.set(payload);
  setStatus("save-status", "已保存 ✓");
}

async function testProvider(provider, statusId) {
  const btn = $(`test-${provider}`);
  btn.disabled = true;
  setStatus(statusId, "测试中…");
  try {
    await saveSettings(); // 先落盘当前输入，确保用最新 key 测试
    const res = await chrome.runtime.sendMessage({ type: "test-provider", provider });
    setStatus(statusId, res.ok ? "连接成功 ✓" : `失败：${res.error}`);
  } catch (e) {
    setStatus(statusId, `异常：${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

$("save-settings").addEventListener("click", saveSettings);
$("test-jev").addEventListener("click", () => testProvider("jev", "test-jev-status"));
$("test-deepseek").addEventListener("click", () => testProvider("deepseek", "test-deepseek-status"));

// ---------------- 配置备份 ----------------
const CONFIG_KEYS = ["jev", "deepseek", "pipeline", "rules", "excludedFolders", "archivedFolderIds"];

$("export-config").addEventListener("click", async () => {
  const all = await chrome.storage.local.get(null);
  const data = { __app: "JW Bookmarks", __exportedAt: new Date().toISOString() };
  for (const k of CONFIG_KEYS) if (k in all) data[k] = all[k];
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `jw-bookmarks-config-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus("config-status", "已导出 ✓");
});

$("import-config").addEventListener("click", () => $("import-file").click());

$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const payload = {};
    for (const k of CONFIG_KEYS) if (data && k in data) payload[k] = data[k];
    if (!Object.keys(payload).length) throw new Error("不是 JW Bookmarks 的配置文件");
    await chrome.storage.local.set(payload);
    await loadSettings();
    setStatus("config-status", "已导入 ✓");
  } catch (err) {
    setStatus("config-status", `导入失败：${err.message}`);
  }
  e.target.value = "";
});

// ---------------- 启动 ----------------
loadSettings();
refreshOrganize();
