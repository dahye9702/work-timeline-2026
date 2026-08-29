const NEWS_KEY = "daily-news";
const KEYWORDS = ["도시가스", "공급비용", "에너지산업", "기후환경부", "산업통상자원부", "탈탄소", "친환경에너지"];

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "public, max-age=300" },
});

function decodeXml(value = "") {
  return value.replace(/<!\[CDATA\[([\s\S]*?)]]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

function tag(block, name) {
  return decodeXml(block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"))?.[1]?.trim() || "");
}

async function collectHeadlines() {
  const results = await Promise.all(KEYWORDS.map(async (keyword) => {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${keyword} when:1d`)}&hl=ko&gl=KR&ceid=KR:ko`;
    const text = await (await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } })).text();
    return [...text.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 4).map((match) => ({
      title: tag(match[1], "title"), url: tag(match[1], "link"), source: tag(match[1], "source"), keyword,
    }));
  }));
  const seen = new Set();
  return results.flat().filter((item) => item.title && item.url && !seen.has(item.url) && seen.add(item.url)).slice(0, 20);
}

async function summarizeWithGemini(env, headlines) {
  if (!env.GEMINI_API_KEY) throw new Error("Gemini API key is not configured");
  const prompt = `당신은 국내 에너지 산업 뉴스 클리핑 편집자입니다. 아래 뉴스 후보 중 중요한 것 최대 8개를 골라 한국어 JSON만 반환하세요. 각 항목은 title, url, source, category, summary(공백 포함 120자 이내) 필드가 필요합니다. summary는 원문을 복사하지 말고 사실 중심으로 새로 작성하세요. category는 도시가스/요금·공급비용/에너지산업/정부정책/탈탄소·친환경 중 하나입니다. 후보:\n${headlines.map((item, index) => `${index + 1}. [${item.keyword}] ${item.title} | ${item.source} | ${item.url}`).join("\n")}`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL || "gemini-3.7-flash"}:generateContent?key=${env.GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.2 } }),
  });
  if (!response.ok) throw new Error(`Gemini request failed: ${response.status}`);
  const raw = (await response.json()).candidates?.[0]?.content?.parts?.[0]?.text;
  const parsed = JSON.parse(raw);
  return (Array.isArray(parsed) ? parsed : parsed.items || []).filter((item) => item.title && item.url && item.summary).slice(0, 8);
}

async function createDailyClipping(env) {
  const headlines = await collectHeadlines();
  const items = await summarizeWithGemini(env, headlines);
  const clipping = { updatedAt: new Date().toISOString(), items };
  await env.NEWS_CACHE.put(NEWS_KEY, JSON.stringify(clipping));
  return clipping;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/news") {
      const saved = await env.NEWS_CACHE.get(NEWS_KEY, "json");
      return json(saved || { updatedAt: null, items: [] });
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(createDailyClipping(env));
  },
};
