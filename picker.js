import { displayPath } from "./lib/i18n.js";

const $ = (id) => document.getElementById(id);
let pending = null;

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

async function main() {
  const data = await chrome.storage.session.get("picker_pending");
  pending = data.picker_pending;
  if (!pending) {
    $("page-title").textContent = "没有待处理的书签";
    $("page-url").textContent = "";
    $("candidates").innerHTML = '<div class="empty">请从浏览器星标或扩展按钮重新触发。</div>';
    $("new-folder-row").hidden = true;
    return;
  }
  $("page-title").textContent = pending.title || "(无标题)";
  $("page-url").textContent = pending.url || "";

  const list = (pending.candidates || [])
    .filter((c) => c.folderId) // 只保留能映射到真实文件夹的候选
    .slice(0, 3)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  const main = $("candidates");
  main.innerHTML = "";
  if (!list.length) {
    main.innerHTML = '<div class="empty">没有找到合适的现有文件夹。</div>';
  }
  list.forEach((c, i) => {
    const pct = Math.round((c.confidence ?? 0) * 100);
    const card = document.createElement("button");
    card.className = "candidate" + (i === 0 ? " top" : "");
    card.innerHTML =
      '<div class="c-head">' +
      '<span class="c-path">' + escapeHtml(displayPath(c.folderPath)) + "</span>" +
      (i === 0 ? '<span class="badge">推荐</span>' : "") +
      "</div>" +
      '<div class="bar"><div class="fill" style="width:' + pct + '%"></div></div>' +
      '<div class="c-foot"><span class="pct">' + pct + '%</span><span class="go">选择 →</span></div>';
    card.addEventListener("click", () => choose(c));
    main.appendChild(card);
  });

  $("new-folder-name").value = pending.newFolder || "";
}

async function choose(c) {
  await chrome.runtime.sendMessage({
    type: "picker-choose",
    bookmarkId: pending.bookmarkId,
    folderId: c.folderId,
  });
  window.close();
}

async function chooseNew() {
  const name = $("new-folder-name").value.trim() || (pending.newFolder || "");
  if (!name) {
    $("new-folder-name").focus();
    return;
  }
  await chrome.runtime.sendMessage({
    type: "picker-new-folder",
    bookmarkId: pending.bookmarkId,
    name,
    fallbackParentId: pending.fallbackParentId,
  });
  window.close();
}

$("new-folder").addEventListener("click", chooseNew);
$("new-folder-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") chooseNew();
});
$("cancel").addEventListener("click", async () => {
  if (pending) await chrome.runtime.sendMessage({ type: "picker-cancel", bookmarkId: pending.bookmarkId });
  window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.picker_pending) main();
});

main();
