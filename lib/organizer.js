// 批量整理存量书签。跑在 background service worker 里，
// 这样即使用户关掉扩展弹窗，整理也会继续，不会被中断。
import { classify, listFolders } from "./classifier.js";

const PROGRESS_KEY = "organize_progress";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let running = false;
let stopFlag = false;
let reviewItems = []; // 待确认项，放内存（进度计数走 session storage）

// 收集要处理的书签。scope: "loose"（顶层散落）| "all"（全部）
// 「排除的文件夹」里的书签会被整树跳过，不参与整理
async function collectTargets(scope) {
  const got = await chrome.storage.local.get("excludedFolders");
  const excluded = (Array.isArray(got.excludedFolders) ? got.excludedFolders : [])
    .map((x) => String(x).trim())
    .filter(Boolean);
  const isOff = (path, title) => excluded.some((e) => e === path || e === title);

  const tree = await chrome.bookmarks.getTree();
  const topIds = new Set();
  const root = tree[0];
  if (root && root.children) {
    for (const top of root.children) topIds.add(top.id);
  }
  const targets = [];
  const walk = (nodes, path, skip) => {
    for (const n of nodes || []) {
      const p = path ? `${path}/${n.title}` : n.title;
      if (n.url) {
        if (!skip && (scope === "all" || topIds.has(n.parentId))) targets.push(n);
      } else {
        const off = skip || isOff(p, n.title);
        if (n.children) walk(n.children, p, off);
      }
    }
  };
  walk(tree, "", false);
  return targets;
}

async function writeProgress(patch) {
  const cur = (await chrome.storage.session.get(PROGRESS_KEY))[PROGRESS_KEY] || {};
  await chrome.storage.session.set({ [PROGRESS_KEY]: { ...cur, ...patch } });
}

export function isOrganizeRunning() {
  return running;
}

export async function getOrganizeState() {
  const progress = (await chrome.storage.session.get(PROGRESS_KEY))[PROGRESS_KEY] || { status: "idle" };
  return { ...progress, running, review: reviewItems };
}

export function stopOrganize() {
  stopFlag = true;
}

export async function startOrganize({ scope = "loose", autoMove = true } = {}) {
  if (running) return { ok: false, error: "已经在整理了" };
  running = true;
  stopFlag = false;
  reviewItems = [];

  try {
    const targets = await collectTargets(scope);
    const folders = await listFolders();
    const folderPathById = new Map(folders.map((f) => [f.id, f.path]));

    let done = 0;
    let moved = 0;
    let reviewed = 0;
    let skipped = 0;

    await writeProgress({
      status: "running",
      scope,
      autoMove,
      total: targets.length,
      done,
      moved,
      reviewed,
      skipped,
      current: "",
      startedAt: Date.now(),
      error: null,
    });

    for (let i = 0; i < targets.length; i++) {
      if (stopFlag) break;
      const bm = targets[i];

      await writeProgress({
        status: "running",
        total: targets.length,
        done,
        moved,
        reviewed,
        skipped,
        current: bm.title || bm.url || "",
      });

      try {
        const decision = await classify({ url: bm.url, title: bm.title });
        const topFolderId = decision.candidates?.[0]?.folderId;
        if (autoMove && decision.autoSave && topFolderId) {
          if (topFolderId !== bm.parentId) {
            await chrome.bookmarks.move(bm.id, { parentId: topFolderId });
            moved++;
          } else {
            skipped++; // 本来就在目标文件夹
          }
        } else {
          reviewed++;
          reviewItems.push({
            id: bm.id,
            title: bm.title || "(无标题)",
            url: bm.url,
            currentPath: folderPathById.get(bm.parentId) || "",
            candidates: (decision.candidates || []).filter((c) => c.folderId).slice(0, 3),
            newFolder: decision.newFolder || "",
          });
        }
      } catch (e) {
        console.warn("[organize] 处理失败", bm.url, e);
        skipped++;
      }

      done++;
      await sleep(60); // 轻微节流，避免过快打 API
    }

    await writeProgress({
      status: stopFlag ? "stopped" : "done",
      total: targets.length,
      done,
      moved,
      reviewed,
      skipped,
      current: "",
      finishedAt: Date.now(),
    });
    return { ok: true };
  } catch (e) {
    const error = String((e && e.message) || e);
    await writeProgress({ status: "error", error, current: "", finishedAt: Date.now() });
    return { ok: false, error };
  } finally {
    running = false;
  }
}

// ---- 待确认项的处理 ----
export async function applyReviewChoice(bookmarkId, folderId) {
  await chrome.bookmarks.move(bookmarkId, { parentId: folderId });
  reviewItems = reviewItems.filter((it) => it.id !== bookmarkId);
  return getOrganizeState();
}

export async function createFolderForBookmark(bookmarkId, name) {
  const clean = String(name || "").trim();
  if (!clean) return getOrganizeState();
  const [bm] = await chrome.bookmarks.get(bookmarkId);
  const folder = await chrome.bookmarks.create({ title: clean, parentId: bm?.parentId });
  await chrome.bookmarks.move(bookmarkId, { parentId: folder.id });
  reviewItems = reviewItems.filter((it) => it.id !== bookmarkId);
  return getOrganizeState();
}

export async function skipReviewItem(bookmarkId) {
  reviewItems = reviewItems.filter((it) => it.id !== bookmarkId);
  return getOrganizeState();
}
