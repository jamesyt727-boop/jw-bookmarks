// 内置默认分类规则（域名 → 文件夹名）。
// 仅当用户「从没保存过规则」时作为起点；保存后以设置页里看到/编辑的为准。
// 文件夹名用单层（末段）名，这样即使用户把它放进了某个大类里，
// classify 里的 resolveFolderId 也能按唯一标题匹配到。
export const DEFAULT_RULES = [
  { type: "domain", pattern: "mp.weixin.qq.com", folderPath: "微信公众号" },
  { type: "domain", pattern: "feishu.cn", folderPath: "飞书" },
  { type: "domain", pattern: "larksuite.com", folderPath: "飞书" },
  { type: "domain", pattern: "yuque.com", folderPath: "语雀" },
  { type: "domain", pattern: "notion.so", folderPath: "Notion" },
  { type: "domain", pattern: "github.com", folderPath: "GitHub" },
  { type: "domain", pattern: "gitee.com", folderPath: "Gitee" },
  { type: "domain", pattern: "gitlab.com", folderPath: "GitLab" },
  { type: "domain", pattern: "juejin.cn", folderPath: "掘金" },
  { type: "domain", pattern: "csdn.net", folderPath: "CSDN" },
  { type: "domain", pattern: "stackoverflow.com", folderPath: "Stack Overflow" },
  { type: "domain", pattern: "developer.mozilla.org", folderPath: "MDN" },
  { type: "domain", pattern: "zhihu.com", folderPath: "知乎" },
  { type: "domain", pattern: "bilibili.com", folderPath: "B站" },
  { type: "domain", pattern: "xiaohongshu.com", folderPath: "小红书" },
  { type: "domain", pattern: "figma.com", folderPath: "Figma" },
];
