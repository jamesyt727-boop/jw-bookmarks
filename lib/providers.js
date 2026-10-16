// 模型服务商客户端：Jev（TypeSafe）与 DeepSeek，各自独立配置，互不依赖。

function trimSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function extractJson(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return {};
  try {
    return JSON.parse(m[0]);
  } catch {
    return {};
  }
}

// ---------- DeepSeek（OpenAI 兼容 chat/completions） ----------
export async function deepseekClassify(cfg, { systemPrompt, userPrompt }) {
  const res = await fetch(`${trimSlash(cfg.endpoint)}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      stream: false,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${await safeText(res)}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  const parsed = extractJson(content);
  // 兼容两种返回：candidates 数组，或旧的单条 folderPath
  const rawCandidates = Array.isArray(parsed.candidates)
    ? parsed.candidates
    : parsed.folderPath
      ? [{ folderPath: parsed.folderPath, confidence: toNumber(parsed.confidence) }]
      : [];
  return {
    // DeepSeek 对网页的「理解」：是什么内容、属于什么领域（会作为上下文喂给 Jev 做最终判断）
    analysis: typeof parsed.analysis === "string" ? parsed.analysis : "",
    candidates: rawCandidates.map((c) => ({
      folderPath: c?.folderPath ?? "",
      confidence: toNumber(c?.confidence),
    })),
    newFolder: parsed.newFolder ?? "",
    raw: data,
  };
}

// ---------- Jev / TypeSafe ----------
// 契约（已按官方 api.md 核对）：POST {endpoint}/v1/systemone
//   请求：{ state, model, questions }，questions 为 map<string, Question>；
//         choice 题的 criteria 为 { 选项名: 描述|null }（选项名=候选收藏夹路径）。
//   响应：{ model, answers: { <id>: { type:"choice", choice, probabilities, confidence } }, usage }
//   错误：401 无效 Key / 422 校验失败 / 429·529 限流过载（可重试）。
export async function jevDecide(cfg, { state, questions }) {
  const res = await fetch(`${trimSlash(cfg.endpoint)}/v1/systemone`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ model: cfg.model, state, questions }),
  });
  if (!res.ok) {
    const status = res.status;
    const body = (await safeText(res)).slice(0, 300);
    const hint =
      status === 401 ? "Jev API Key 无效或缺失"
      : status === 422 ? `Jev 请求校验失败：${body}`
      : status === 429 ? "Jev 触发限流，请稍后重试"
      : status === 529 ? "Jev 服务过载，请稍后重试"
      : `Jev HTTP ${status}`;
    throw new Error(hint);
  }
  const data = await res.json();
  return parseJevResponse(data);
}

// 解析 systemone 响应：取第一个（也是唯一的）问题答案。
function parseJevResponse(data) {
  const answer = Object.values(data?.answers ?? {})[0] ?? {};
  const probabilities =
    answer.probabilities && typeof answer.probabilities === "object" ? answer.probabilities : {};
  return {
    choice: typeof answer.choice === "string" ? answer.choice : null,
    probabilities,
    confidence: toNumber(answer.confidence),
    model: data?.model ?? null,
    raw: data,
  };
}
