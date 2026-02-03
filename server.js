import "dotenv/config";

import http from "http";
import { readFile } from "fs/promises";
import { extname, join } from "path";

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = join(process.cwd(), "public");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const SYSTEM_PROMPT = `You are an interview coach for product and UX/UI designers.\nYou receive the raw text of a design job posting.\nExtract the role level (junior/mid/senior/lead/staff/director/unknown) and likely design focus, then generate 6-10 behavioral interview questions tailored to the role.\nQuestions must be behavioral (about past actions, decisions, tradeoffs, collaboration, ambiguity, impact).\nAvoid generic or fluffy questions.\nWrite questions in English and in a specific, senior-friendly style ("Tell me about a time...", "Describe a project...", "Give an example...").\nIf the posting suggests platform, B2B/SaaS, design systems, or enterprise scope, make questions reflect that.\nGroup questions by theme.\nOutput JSON only.`;

const SCHEMA_HINT = `Return a JSON object with keys:\n- role_level: one of ["junior","mid","senior","lead","staff","director","unknown"]\n- focus: short string like "product design", "ux/ui", "design systems", "research-heavy", "growth", "enterprise", "consumer", etc.\n- themes: array of objects with keys:\n  - theme: short label like "Strategy & Problem Framing", "End-to-End Execution", "Design Systems & Visual Language", "Collaboration & Influence", "Ambiguity & Tradeoffs", "Impact & Metrics"\n  - questions: array of 1-3 strings\nTotal questions across all themes must be 6-10.`;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function decodeEntities(text) {
  return text
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function extractTextFromHtml(html) {
  const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  const noStyles = noScripts.replace(/<style[\s\S]*?<\/style>/gi, " ");
  const noNoscript = noStyles.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const noTags = noNoscript.replace(/<[^>]+>/g, " ");
  return decodeEntities(noTags);
}

async function fetchJobText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch page. Status ${response.status}`);
  }

  const html = await response.text();
  const text = extractTextFromHtml(html);

  if (!text || text.length < 200) {
    throw new Error("Not enough readable text found on the page.");
  }

  return text.slice(0, 12000);
}

function normalizeJobText(text) {
  const cleaned = decodeEntities(text || "");
  return cleaned.slice(0, 12000);
}

function inferSeniorityFromText(jobText) {
  const text = (jobText || "").toLowerCase();
  const has = (pattern) => pattern.test(text);

  if (has(/\b(director|vp|head of design|design director)\b/)) return "director";
  if (has(/\b(staff|principal|lead)\b/)) return "staff";
  if (has(/\b(senior|sr\.?|senior-level)\b/)) return "senior";
  if (has(/\b(mid|mid-level|intermediate)\b/)) return "mid";
  if (has(/\b(junior|jr\.?|entry[- ]level)\b/)) return "junior";

  return "unknown";
}

async function callOpenAI(jobText) {
  if (!OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY in environment.");
  }

  const heuristicLevel = inferSeniorityFromText(jobText);
  const userPrompt = `Job posting text (English):\n${jobText}\n\n${SCHEMA_HINT}`;
  const responseSchema = {
    name: "design_role_questions",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        role_level: {
          type: "string",
          enum: ["junior", "mid", "senior", "lead", "staff", "director", "unknown"]
        },
        focus: { type: "string" },
        themes: {
          type: "array",
          minItems: 3,
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              theme: { type: "string" },
              questions: {
                type: "array",
                minItems: 1,
                maxItems: 3,
                items: { type: "string" }
              }
            },
            required: ["theme", "questions"]
          }
        }
      },
      required: ["role_level", "focus", "themes"]
    },
    strict: true
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      instructions: `${SYSTEM_PROMPT}\nHeuristic seniority hint from text (may be unknown): ${heuristicLevel}. If the posting explicitly names a level, prioritize that.`,
      input: userPrompt,
      text: {
        format: {
          type: "json_schema",
          ...responseSchema
        }
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const outputItems = Array.isArray(data.output) ? data.output : [];
  const message = outputItems.find((item) => item.type === "message");
  const content = message?.content || [];
  const textPart = content.find((part) => part.type === "output_text");
  const raw = textPart?.text || "";

  if (!raw) {
    throw new Error("OpenAI response missing output text.");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("OpenAI returned non-JSON output.");
  }

  if (!parsed.themes || !Array.isArray(parsed.themes)) {
    throw new Error("OpenAI JSON missing themes array.");
  }

  if (parsed.role_level === "unknown" && heuristicLevel !== "unknown") {
    return { ...parsed, role_level: heuristicLevel };
  }

  return parsed;
}

async function handleApiAnalyze(req, res) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });

  req.on("end", async () => {
    try {
      const payload = JSON.parse(body || "{}");
      const url = payload?.url;
      const rawText = payload?.text;

      let jobText = "";
      if (rawText && typeof rawText === "string" && rawText.trim().length >= 200) {
        jobText = normalizeJobText(rawText);
      } else if (url && isValidHttpUrl(url)) {
        jobText = await fetchJobText(url);
      } else {
        return sendJson(res, 400, { error: "Please provide a valid URL or paste the job text." });
      }

      const analysis = await callOpenAI(jobText);

      return sendJson(res, 200, { analysis });
    } catch (err) {
      return sendJson(res, 500, { error: err.message || "Server error" });
    }
  });
}

async function serveStatic(req, res) {
  const urlPath = req.url === "/" ? "/index.html" : req.url;
  const safePath = urlPath.split("?")[0];
  const filePath = join(PUBLIC_DIR, safePath);
  const ext = extname(filePath);

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream"
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url.startsWith("/api/analyze")) {
    return handleApiAnalyze(req, res);
  }

  if (req.method === "GET") {
    return serveStatic(req, res);
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
