import { classify, getSettings } from "./lib/classifier.js";
import { deepseekClassify, jevDecide } from "./lib/providers.js";
import {
  startOrganize,
  stopOrganize,
  getOrganizeState,
  isOrganizeRunning,
  applyReviewChoice,
  createFolderForBookmark,
  skipReviewItem,
} from "./lib/organizer.js";

const pending = new Map(); // bookmarkId -> { timer, node }
const selfMoved = new Set(); // 我们自己 move 的 id，避免被 onMoved 误判为手动操作
let creatingSelf = false; // 扩展自己 create 书签时的标记，跳过 onCreated 的自动分类
let pickerWindowId = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "smart-bookmark-save",
      title: "收藏到自动分类",
      contexts: ["page", "link"],
    });
  });
});

// ---------- 原生星标：事后自动搬运 ----------
chrome.bookmarks.onCreated.addListener((id, node) => {
  if (creatingSelf) {
    creatingSelf = false; // 扩展自己 create 的书签，直接走 classifyAndSave，不再触发此流程
    return;
  }
  if (!node || !node.url) return; // 只关心书签，不关心新建文件夹
  getSettings().then((s) => {
    if (!s.pipeline.autoMove) return;
    const ms = Number(s.pipeline.debounceMs) || 3000;
    // 等一会儿，若用户在原生弹窗里手动改了标题/文件夹就放弃自动分类
    const timer = setTimeout(() => finalize(id, node), ms);
    pending.set(id, { timer, node });
  });
});

chrome.bookmarks.onChanged.addListener((id, info) => {
  if (pending.has(id) && (info.title !== undefined || info.url !== undefined)) {
    cancelPending(id); // 用户改了标题/网址，尊重手动操作
  }
});

chrome.bookmarks.onMoved.addListener((id) => {
  if (selfMoved.has(id)) {
    selfMoved.delete(id);
    return;
  }
  if (pending.has(id)) cancelPending(id); // 用户手动换了文件夹
});

chrome.bookmarks.onRemoved.addListener((id) => {
  if (pending.has(id)) cancelPending(id);
});

function cancelPending(id) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
}

async function finalize(id, node) {
  const p = pending.get(id);
  pending.delete(id);
  if (!p) return;
  try {
    const [cur] = await chrome.bookmarks.get(id);
    if (!cur || cur.url !== node.url || cur.title !== node.title) return; // 已被删/改
    const decision = await classify({ url: cur.url, title: cur.title });
    await applyDecision(id, decision, cur.parentId);
  } catch (e) {
    console.error("[smart-bookmark] 自动分类失败", e);
    flashBadge("!", "#dc2626");
  }
}

// 把决策落地：很确定→直接移动；否则→弹窗让用户选。返回是否弹了窗。
async function applyDecision(bookmarkId, decision, fallbackParentId) {
  if (decision.autoSave && decision.candidates[0]?.folderId) {
    selfMoved.add(bookmarkId);
    await chrome.bookmarks.move(bookmarkId, { parentId: decision.candidates[0].folderId });
    flashBadge("✓", "#16a34a");
    return false;
  }
  if (!decision.candidates?.length && !decision.newFolder) {
    flashBadge("?", "#f59e0b");
    return false;
  }
  await openPicker(bookmarkId, decision, fallbackParentId);
  return true;
}

async function openPicker(bookmarkId, decision, fallbackParentId) {
  let url = "";
  let title = "";
  try {
    const [bm] = await chrome.bookmarks.get(bookmarkId);
    url = bm?.url || "";
    title = bm?.title || "";
  } catch {}
  await chrome.storage.session.set({
    picker_pending: {
      bookmarkId,
      url,
      title,
      candidates: decision.candidates || [],
      newFolder: decision.newFolder || "",
      fallbackParentId,
    },
  });
  if (pickerWindowId != null) {
    try {
      await chrome.windows.update(pickerWindowId, { focused: true });
      return;
    } catch {
      pickerWindowId = null;
    }
  }
  const created = await chrome.windows.create({
    url: "picker.html",
    type: "popup",
    width: 380,
    height: 560,
    ...(await anchorFromFocusedWindow(380)),
  });
  pickerWindowId = created.id;
}

// 让弹窗出现在当前浏览器窗口右上角（地址栏 / 书签星标下方），而不是屏幕左上角
async function anchorFromFocusedWindow(width, toolbarOffset = 90) {
  try {
    const win = await chrome.windows.getLastFocused();
    if (win && Number.isFinite(win.left) && Number.isFinite(win.width)) {
      return {
        left: Math.round(win.left + win.width - width - 24),
        top: Math.round((win.top ?? 0) + toolbarOffset),
      };
    }
  } catch {}
  return {};
}

chrome.windows.onRemoved.addListener((id) => {
  if (id === pickerWindowId) pickerWindowId = null;
});

function flashBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3000);
}

// ---------- 手动触发：右键菜单 / popup ----------
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "smart-bookmark-save") return;
  const url = info.linkUrl || info.pageUrl || (tab && tab.url);
  const title = info.linkUrl ? info.selectionText || url : (tab && tab.title) || url;
  if (!url) return;
  classifyAndSave(url, title).then((res) => {
    if (!res.ok) flashBadge("!", "#dc2626");
  });
});

async function classifyAndSave(url, title) {
  try {
    const decision = await classify({ url, title });
    creatingSelf = true;
    let bm;
    try {
      bm = await chrome.bookmarks.create({ title: title || url, url });
    } catch (e) {
      creatingSelf = false;
      throw e;
    }
    const openedPicker = await applyDecision(bm.id, decision, bm.parentId);
    return { ok: true, decision, openedPicker };
  } catch (e) {
    creatingSelf = false;
    console.error("[smart-bookmark] 手动收藏失败", e);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 列出书签栏的顶层文件夹（供归档选择），附带每个文件夹的书签数
async function getTopFolders() {
  const tree = await chrome.bookmarks.getTree();
  const roots = tree[0]?.children || [];
  const bar = roots.find((c) => /书签栏|bookmarks bar/i.test(c.title)) || roots[0];
  if (!bar) return { barId: null, folders: [], looseCount: 0 };

  const countUrls = (node) => {
    let n = 0;
    for (const c of node.children || []) n += c.url ? 1 : countUrls(c);
    return n;
  };

  const folders = [];
  let looseCount = 0;
  for (const child of bar.children || []) {
    if (child.url) looseCount++;
    else if (!/^旧收藏/.test(child.title || "")) folders.push({ id: child.id, title: child.title, count: countUrls(child) });
  }
  return { barId: bar.id, folders, looseCount };
}

// 归档选中的文件夹（+ 可选散落书签）到指定名称的归档文件夹，并记录 id 供分类排除
async function archiveFolders({ folderIds = [], loose = false, archiveName }) {
  const name = String(archiveName || "").trim() || `旧收藏 ${new Date().getFullYear()}`;
  const tree = await chrome.bookmarks.getTree();
  const roots = tree[0]?.children || [];
  const bar = roots.find((c) => /书签栏|bookmarks bar/i.test(c.title)) || roots[0];
  if (!bar) return { ok: false, error: "找不到书签栏" };

  let archiveFolder = (bar.children || []).find((c) => !c.url && c.title === name);
  if (!archiveFolder) {
    archiveFolder = await chrome.bookmarks.create({ title: name, parentId: bar.id });
  }

  let moved = 0;
  for (const id of folderIds) {
    if (id === archiveFolder.id) continue;
    await chrome.bookmarks.move(id, { parentId: archiveFolder.id });
    moved++;
  }
  if (loose) {
    for (const child of bar.children || []) {
      if (child.url) {
        await chrome.bookmarks.move(child.id, { parentId: archiveFolder.id });
        moved++;
      }
    }
  }

  const got = await chrome.storage.local.get("archivedFolderIds");
  const ids = new Set(Array.isArray(got.archivedFolderIds) ? got.archivedFolderIds : []);
  ids.add(archiveFolder.id);
  await chrome.storage.local.set({ archivedFolderIds: [...ids] });

  flashBadge("✓", "#16a34a");
  return { ok: true, moved, archiveName: name };
}

// 批量新建文件夹（建在「书签栏」下；已存在的自动跳过）
async function createFolders(names) {
  const list = (Array.isArray(names) ? names : []).map((x) => String(x).trim()).filter(Boolean);
  if (!list.length) return { ok: false, error: "没有要新建的文件夹名" };

  const tree = await chrome.bookmarks.getTree();
  const roots = tree[0]?.children || [];
  const bar = roots.find((c) => /书签栏|bookmarks bar/i.test(c.title)) || roots[0];
  if (!bar) return { ok: false, error: "找不到书签栏" };

  const existing = new Set((bar.children || []).filter((c) => !c.url).map((c) => c.title));
  let created = 0;
  let skipped = 0;
  for (const name of list) {
    if (existing.has(name)) {
      skipped++;
      continue;
    }
    await chrome.bookmarks.create({ title: name, parentId: bar.id });
    existing.add(name);
    created++;
  }
  flashBadge("✓", "#16a34a");
  return { ok: true, created, skipped };
}

// ---------- 消息（popup / options / picker 调用） ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "classify-dry-run") {
    classify({ url: msg.url, title: msg.title })
      .then((decision) => sendResponse({ ok: true, decision }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === "classify-and-save") {
    classifyAndSave(msg.url, msg.title).then(sendResponse);
    return true;
  }
  if (msg.type === "test-provider") {
    testProvider(msg.provider).then(sendResponse);
    return true;
  }
  if (msg.type === "picker-choose") {
    (async () => {
      try {
        selfMoved.add(msg.bookmarkId);
        await chrome.bookmarks.move(msg.bookmarkId, { parentId: msg.folderId });
        flashBadge("✓", "#16a34a");
      } catch (e) {
        console.error("[smart-bookmark] 选择分类失败", e);
        flashBadge("!", "#dc2626");
      }
      await chrome.storage.session.remove("picker_pending");
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === "picker-new-folder") {
    (async () => {
      const name = String(msg.name || "").trim();
      if (!name) {
        await chrome.storage.session.remove("picker_pending");
        sendResponse({ ok: false, error: "未填写文件夹名" });
        return;
      }
      try {
        const folder = await chrome.bookmarks.create({
          title: name,
          parentId: msg.fallbackParentId,
        });
        selfMoved.add(msg.bookmarkId);
        await chrome.bookmarks.move(msg.bookmarkId, { parentId: folder.id });
        flashBadge("✓", "#16a34a");
      } catch (e) {
        console.error("[smart-bookmark] 新建文件夹失败", e);
        flashBadge("!", "#dc2626");
      }
      await chrome.storage.session.remove("picker_pending");
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === "picker-cancel") {
    chrome.storage.session.remove("picker_pending").then(() => sendResponse({ ok: true }));
    return true;
  }
  // ---- 批量整理（跑在后台 service worker，弹窗只负责显示进度）----
  if (msg.type === "organize-run") {
    if (isOrganizeRunning()) {
      sendResponse({ ok: false, error: "已经在整理了" });
    } else {
      startOrganize({ scope: msg.scope, autoMove: msg.autoMove }); // 不 await，后台继续跑
      sendResponse({ ok: true });
    }
    return true;
  }
  if (msg.type === "organize-stop") {
    stopOrganize();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "organize-state") {
    getOrganizeState().then((state) => sendResponse({ ok: true, state }));
    return true;
  }
  if (msg.type === "organize-choose") {
    applyReviewChoice(msg.bookmarkId, msg.folderId)
      .then((state) => sendResponse({ ok: true, state }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === "organize-new-folder") {
    createFolderForBookmark(msg.bookmarkId, msg.name)
      .then((state) => sendResponse({ ok: true, state }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === "organize-skip") {
    skipReviewItem(msg.bookmarkId).then((state) => sendResponse({ ok: true, state }));
    return true;
  }
  if (msg.type === "list-top-folders") {
    getTopFolders()
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === "archive-folders") {
    archiveFolders(msg)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === "create-folders") {
    createFolders(msg.names)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  return false;
});

async function testProvider(provider) {
  const s = await getSettings();
  try {
    if (provider === "deepseek") {
      const cfg = s.deepseek;
      if (!cfg.apiKey) return { ok: false, error: "未配置 DeepSeek API Key" };
      await deepseekClassify(cfg, {
        systemPrompt: "ping",
        userPrompt: '返回 JSON: {"ok":true}',
      });
      return { ok: true };
    }
    if (provider === "jev") {
      const cfg = s.jev;
      if (!cfg.apiKey) return { ok: false, error: "未配置 Jev API Key" };
      await jevDecide(cfg, {
        state: "连接测试",
        questions: {
          ping: { type: "choice", instructions: "选择 ok", criteria: { ok: null } },
        },
      });
      return { ok: true };
    }
    return { ok: false, error: "未知 provider" };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
