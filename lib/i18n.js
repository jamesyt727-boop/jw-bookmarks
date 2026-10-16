// 界面显示用的文案本地化。注意：只影响「显示」，不改动真实文件夹名。
// Chrome 默认根文件夹会跟随浏览器创建时的语言，中文环境下常被显示成英文，
// 这里在展示时统一映射成中文。
const ROOT_LABELS = {
  "bookmarks bar": "书签栏",
  "bookmarks_bar": "书签栏",
  "bookmarksbar": "书签栏",
  "other bookmarks": "其他书签",
  "other_bookmarks": "其他书签",
  "otherbookmarks": "其他书签",
  "mobile bookmarks": "移动设备书签",
  "mobile_bookmarks": "移动设备书签",
  "mobilebookmarks": "移动设备书签",
};

export function displayFolderName(name) {
  const raw = String(name ?? "");
  const key = raw.trim().toLowerCase();
  return ROOT_LABELS[key] ?? raw;
}

// 本地化路径的第一段（根文件夹）；「书签栏/」这类系统根前缀在展示时省略，
// 这样「书签栏/家音」显示成「家音」，更贴近用户的叫法。
export function displayPath(path) {
  const segs = String(path ?? "").split("/").filter(Boolean);
  if (!segs.length) return "";
  segs[0] = displayFolderName(segs[0]);
  if (segs.length > 1 && /^(书签栏|其他书签|移动设备书签)$/.test(segs[0])) segs.shift();
  return segs.join("/");
}
