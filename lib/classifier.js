import { deepseekClassify, jevDecide } from "./providers.js";
import { DEFAULT_RULES } from "./defaults.js";

const DEFAULTS = {
  jev: { endpoint: "https://api.typesafe.ai", model: "jev-latest", apiKey: "", enabled: true },
  deepseek: { endpoint: "https://api.deepseek.com", model: "deepseek-flash", apiKey: "", enabled: true },
  pipeline: { autoMove: true, autoSaveThreshold: 0.8, debounceMs: 3000 },
};

export async function getSettings() {
  const got = await chrome.storage.local.get(null);
  return {
    jev: { ...DEFAULTS.jev, ...(got.jev || {}) },
    deepseek: { ...DEFAULTS.deepseek, ...(got.deepseek || {}) },
    pipeline: { ...DEFAULTS.pipeline, ...(got.pipeline || {}) },
    rules: Array.isArray(got.rules) && got.rules.length ? got.rules : DEFAULT_RULES,
    excludedFolders: Array.isArray(got.excludedFolders) ? got.excludedFolders : [],
  };
}

// 判断某个文件夹（按「名字」或「父/子 路径」）是否在用户的排除名单里
function isExcludedFolder(nameOrPath, excluded) {
  if (!Array.isArray(excluded) || !excluded.length) return false;
  const s = String(nameOrPath || "").trim();
  const last = s.split("/").pop();
  return excluded.some((e) => e === s || e === last);
}

// 把书签树拍平成 [{ id, path, title }]，path 形如 "书签栏/工作/前端"
// 只有「真正的用户文件夹」会成为候选；以下一律跳过：
//   0) Chrome 的三个系统根（书签栏 / 其他书签 / 移动设备书签）—— 它们没有分类意义，
//      而「其他书签」语义上就是个兜底筐，模型会把不认识的网页全塞进去；
//   1) 归档文件夹 —— 按 id（archivedFolderIds），id 丢失时按名字前缀「旧收藏」兜底；
//   2) 用户在设置里「排除的文件夹」—— 按名字或路径匹配。
export async function listFolders() {
  const got = await chrome.storage.local.get(["archivedFolderIds", "excludedFolders"]);
  const archived = new Set(Array.isArray(got.archivedFolderIds) ? got.archivedFolderIds : []);
  const excluded = (Array.isArray(got.excludedFolders) ? got.excludedFolders : [])
    .map((x) => String(x).trim())
    .filter(Boolean);
  const tree = await chrome.bookmarks.getTree();
  const out = [];
  // 取该文件夹里前几个书签标题，作为「这个夹大概装什么」的线索。
  // 光有文件夹名，决策模型压根不知道「运维工作」里装的其实是阿里云控制台。
  const samplesOf = (node, max = 4) => {
    const acc = [];
    const collect = (n) => {
      for (const c of n.children || []) {
        if (acc.length >= max) return;
        if (c.url) {
          const t = String(c.title || "").trim();
          if (t) acc.push(t);
        } else {
          collect(c);
        }
      }
    };
    collect(node);
    return acc.slice(0, max);
  };
  const walk = (nodes, path, depth) => {
    for (const n of nodes || []) {
      if (n.url) continue; // 跳过书签节点，只看文件夹
      const p = path ? `${path}/${n.title}` : n.title;
      if (depth >= 2) {
        if (archived.has(n.id) || /^旧收藏/.test(n.title || "") || isExcludedFolder(p, excluded)) continue;
        out.push({ id: n.id, path: p, title: n.title, samples: samplesOf(n) });
      }
      if (n.children) walk(n.children, p, depth + 1);
    }
  };
  walk(tree, "", 0);
  return out;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function matchRule(rules, url, title) {
  const host = hostOf(url).toLowerCase();
  for (const r of rules) {
    if (!r || !r.pattern) continue;
    const p = String(r.pattern).toLowerCase();
    if (r.type === "domain") {
      // 精确域名 / 子域名匹配，避免 github.com 误伤 notgithub.com
      if (host === p || host.endsWith("." + p)) return r.folderPath;
    } else {
      const hay = `${title} ${url}`.toLowerCase();
      if (hay.includes(p)) return r.folderPath;
    }
  }
  return null;
}

// 把分类结果里的路径映射回真实文件夹 id；支持末段名唯一匹配
function resolveFolderId(folderPath, folders) {
  if (!folderPath) return null;
  const exact = folders.find((f) => f.path === folderPath);
  if (exact) return exact.id;
  const ci = folders.find((f) => f.path.toLowerCase() === folderPath.toLowerCase());
  if (ci) return ci.id;
  const last = String(folderPath).split("/").pop();
  const byTitle = folders.filter((f) => f.title.toLowerCase() === last.toLowerCase());
  return byTitle.length === 1 ? byTitle[0].id : null;
}

// 确保路径对应的文件夹存在，不存在则逐级创建（挂在「书签栏」下），返回文件夹 id
async function ensureFolder(folderPath) {
  const parts = String(folderPath).split("/").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const tree = await chrome.bookmarks.getTree();
  const topChildren = tree[0]?.children || [];
  const bar = topChildren.find((c) => /书签栏|bookmarks bar/i.test(c.title)) || topChildren[0];
  let parentId = bar?.id;
  if (!parentId) return null;
  let currentId = null;
  for (const part of parts) {
    const [node] = await chrome.bookmarks.getSubTree(parentId);
    const existing = (node?.children || []).find((c) => !c.url && c.title === part);
    if (existing) {
      currentId = existing.id;
    } else {
      const created = await chrome.bookmarks.create({ title: part, parentId });
      currentId = created.id;
    }
    parentId = currentId;
  }
  return currentId;
}

// 主分类流程：本地规则 → Jev（很确定直接存）→ DeepSeek（top-3 候选供弹窗）
// 返回 { engine, candidates: [{folderPath, folderId, confidence}], newFolder, autoSave }
export async function classify({ url, title }) {
  const s = await getSettings();
  const threshold = Number(s.pipeline.autoSaveThreshold);

  // 1) 本地规则（不联网，优先级最高，直接保存；文件夹不存在则自动创建）
  //    若规则目标被列进「排除的文件夹」，跳过该规则，交给后面的模型
  const ruleHit = matchRule(s.rules, url, title);
  if (ruleHit && !isExcludedFolder(ruleHit, s.excludedFolders)) {
    const folders = await listFolders();
    let folderId = resolveFolderId(ruleHit, folders);
    if (!folderId) folderId = await ensureFolder(ruleHit);
    return {
      engine: "rule",
      candidates: [{ folderPath: ruleHit, folderId, confidence: 1 }],
      newFolder: "",
      autoSave: !!folderId,
    };
  }

  const folders = await listFolders();
  const folderPaths = folders.map((f) => f.path);
  const byPath = new Map(folders.map((f) => [f.path, f]));
  const samplesOfPath = (p) => byPath.get(p)?.samples || [];

  // 2) DeepSeek「分析」：读懂网页 + 现有文件夹结构，做高召回初筛，必要时建议新文件夹名
  //    （LLM 的强项是理解与生成，不指望它的概率准）
  let analysis = "";
  let shortlist = []; // [{ folderPath, confidence }]
  let newFolder = "";
  if (s.deepseek.enabled && s.deepseek.apiKey && folderPaths.length > 0) {
    const systemPrompt = [
      "你是书签分类的「分析」助手。你的任务不是最终定夺，而是：读懂这个网页讲什么，再从用户已有的收藏夹里高召回地初筛候选，交给后面的决策模型定夺。",
      "规则：",
      "1) 先看域名判断这个网址属于哪个网站 / 哪个产品 / 哪家公司，它主要是做什么的——控制台、后台、登录页、仪表盘这类页面要按它「所属的产品或公司」归类，别被路径里的泛化英文（如 dashboard、product、service）带偏；",
      "2) 只能从下面列出的已有文件夹里挑候选，不要编造路径；",
      "3) 候选按贴合度从高到低排序，最多 6 个——宁可多给几个别漏，也别只给一个；",
      "4) analysis 用一两句中文说清：这个网页是什么、属于什么领域；",
      "5) 如果现有文件夹都不贴切，把 newFolder 填上一个更合适的新文件夹名（中文、简短），否则留空字符串；",
      "6) 只输出 JSON，不要输出其他文字。",
    ].join("\n");

    const userPrompt = [
      "现有收藏夹（用 / 表示层级，括号里是该文件夹的典型内容）：",
      folderPaths
        .map((p) => {
          const s = samplesOfPath(p);
          return s.length ? `- ${p}（典型内容：${s.join("、")}）` : `- ${p}`;
        })
        .join("\n"),
      "",
      "待分类网页：",
      `标题：${title || "(无标题)"}`,
      `网址：${url}`,
      "",
      '输出 JSON：{"analysis":"<这个网页是什么、属于什么领域>","candidates":[{"folderPath":"<路径>","confidence":0.6}],"newFolder":"<没有就空字符串>"}',
    ].join("\n");

    try {
      const r = await deepseekClassify(s.deepseek, { systemPrompt, userPrompt });
      analysis = r.analysis || "";
      newFolder = r.newFolder || "";
      const raw = (r.candidates || []).slice(0, 6);
      // 先按精确路径过滤；若模型写的路径有细微出入，再用 resolveFolderId 兜一层
      shortlist = raw.filter((c) => c.folderPath && folderPaths.includes(c.folderPath));
      if (!shortlist.length) shortlist = raw.filter((c) => c.folderPath && resolveFolderId(c.folderPath, folders));
    } catch (e) {
      console.warn("[smart-bookmark] DeepSeek 分析失败，改用 Jev 直接判断", e);
    }
  }

  // 3) Jev「判断」：把 DeepSeek 的分析当上下文，判断该归到哪里，给出校准过的概率与置信度
  //    候选用「全部文件夹」而不是只限 DeepSeek 的初筛：初筛一旦漏掉正确项，Jev 就永远选不到了。
  //    DeepSeek 的价值在这里是「提供理解」而非「限定选项」。
  const judgePaths = folderPaths;
  if (s.jev.enabled && s.jev.apiKey && judgePaths.length > 0) {
    try {
      const r = await jevDecide(s.jev, {
        state: { title, url, ...(analysis ? { analysis } : {}) },
        questions: {
          folder: {
            type: "choice",
            instructions:
              "结合网页内容与上面的分析，从这些文件夹里选出最合适的。每个选项都附了该文件夹的典型内容，请据此判断，不要只看文件夹名字面。",
            criteria: Object.fromEntries(
              judgePaths.map((p) => {
                const s = samplesOfPath(p);
                return [p, s.length ? `该文件夹的典型内容：${s.join("、")}` : null];
              }),
            ),
          },
        },
      });
      const candidates = jevToCandidates(r, folders);
      const top = candidates[0];
      return {
        engine: analysis ? "deepseek+jev" : "jev",
        candidates,
        newFolder, // 新文件夹名只能由 DeepSeek 生成
        analysis, // 一并带出，方便「分析当前页」看清它怎么想的
        autoSave: !!(top && top.confidence != null && top.confidence >= threshold),
      };
    } catch (e) {
      console.warn("[smart-bookmark] Jev 判断失败，改用 DeepSeek 的初筛结果", e);
    }
  }

  // 4) Jev 不可用 → 直接用 DeepSeek 的初筛结果
  if (shortlist.length || newFolder) {
    const candidates = shortlist
      .map((c) => ({ folderPath: c.folderPath, folderId: resolveFolderId(c.folderPath, folders), confidence: c.confidence }))
      .filter((c) => c.folderId && c.folderPath)
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 3);
    const top = candidates[0];
    return {
      engine: "deepseek",
      candidates,
      newFolder,
      autoSave: !!(top && top.confidence != null && top.confidence >= threshold),
    };
  }

  // 5) 什么都没配置
  return { engine: "none", candidates: [], newFolder: "", autoSave: false };
}

// 把 Jev 的概率分布转成候选列表（降序，最多 3 个）
function jevToCandidates(r, folders) {
  const entries = Object.entries(r.probabilities || {});
  const source = entries.length
    ? entries
    : r.choice
      ? [[r.choice, r.confidence ?? 0]]
      : [];
  return source
    .map(([folderPath, confidence]) => ({
      folderPath,
      folderId: resolveFolderId(folderPath, folders),
      confidence,
    }))
    .filter((c) => c.folderId && c.folderPath && c.confidence != null)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
}
