import "dotenv/config";

import http from "http";
import { readFile, writeFile } from "fs/promises";
import { extname, join } from "path";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = join(process.cwd(), "public");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANALYTICS_PATH = join(process.cwd(), "analytics.json");
const LINKS_PATH = join(process.cwd(), "job_links.json");

let analytics = {
  totalVisits: 0,
  lastUpdated: null
};
let jobLinks = [];

async function loadAnalytics() {
  try {
    const raw = await readFile(ANALYTICS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.totalVisits === "number") {
      analytics = {
        totalVisits: parsed.totalVisits,
        lastUpdated: parsed.lastUpdated || null
      };
    }
  } catch {
    // No analytics yet; start fresh.
  }
}

async function persistAnalytics() {
  analytics.lastUpdated = new Date().toISOString();
  await writeFile(ANALYTICS_PATH, `${JSON.stringify(analytics, null, 2)}\n`);
}

async function loadJobLinks() {
  try {
    const raw = await readFile(LINKS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      jobLinks = parsed;
    }
  } catch {
    // No links yet; start fresh.
  }
}

async function persistJobLinks() {
  await writeFile(LINKS_PATH, `${JSON.stringify(jobLinks, null, 2)}\n`);
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const SYSTEM_PROMPT = `You are an interview coach for product and UX/UI designers.\nYou receive the raw text of a design job posting.\nExtract the role level (junior/mid/senior/lead/staff/director/unknown), role type (ic/manager/mixed/unknown), likely domain (b2b/consumer/enterprise/saas/unknown), and likely design focus.\nDetect and return key signals (tags) from the posting.\nThen generate 6-10 behavioral interview questions tailored to the role.\nQuestions must be behavioral (about past actions, decisions, tradeoffs, collaboration, ambiguity, impact).\nAvoid generic or fluffy questions.\nWrite questions in English and in a specific, senior-friendly style ("Tell me about a time...", "Describe a project...", "Give an example...").\nQuestions must be evidence-anchored: each theme should explicitly reflect the detected signals.\nIf the posting suggests platform, B2B/SaaS, design systems, or enterprise scope, make questions reflect that.\nGroup questions by theme.\nOutput JSON only.`;

const SCHEMA_HINT = `Return a JSON object with keys:\n- role_level: one of ["junior","mid","senior","lead","staff","director","unknown"]\n- role_type: one of ["ic","manager","mixed","unknown"]\n- domain: one of ["b2b","consumer","enterprise","saas","unknown"]\n- focus: short string like "product design", "ux/ui", "design systems", "research-heavy", "growth", "enterprise", "consumer", etc.\n- signals: array of 3-10 strings (keywords/tags extracted from the posting)\n- themes: array of objects with keys:\n  - theme: short label like "Strategy & Problem Framing", "End-to-End Execution", "Design Systems & Visual Language", "Collaboration & Influence", "Ambiguity & Tradeoffs", "Impact & Metrics"\n  - questions: array of 1-3 strings\nTotal questions across all themes must be 6-10.`;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html)
  });
  res.end(html);
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

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractJsonLdJobPosting(document) {
  const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
  const candidates = [];

  scripts.forEach((script) => {
    const parsed = safeJsonParse(script.textContent || "");
    if (!parsed) return;
    if (Array.isArray(parsed)) {
      candidates.push(...parsed);
    } else if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed["@graph"])) {
        candidates.push(...parsed["@graph"]);
      } else {
        candidates.push(parsed);
      }
    }
  });

  const jobPosting = candidates.find((item) => {
    const type = item?.["@type"];
    if (Array.isArray(type)) return type.includes("JobPosting");
    return type === "JobPosting";
  });

  if (!jobPosting) return null;

  const parts = [
    jobPosting.title,
    jobPosting.description,
    jobPosting.responsibilities,
    jobPosting.qualifications,
    jobPosting.experienceRequirements,
    jobPosting.skills
  ]
    .filter(Boolean)
    .map((part) => {
      const value = String(part);
      return value.includes("<") ? extractTextFromHtml(value) : value;
    });

  const text = parts.join("\n\n");
  return text ? normalizeJobText(text) : null;
}

function extractMetaDescription(document) {
  const meta =
    document.querySelector('meta[property="og:description"]') ||
    document.querySelector('meta[name="twitter:description"]') ||
    document.querySelector('meta[name="description"]');

  const content = meta?.getAttribute("content");
  return content ? normalizeJobText(content) : null;
}

function extractFromAshby(document) {
  const script = document.querySelector('script#__NEXT_DATA__');
  if (!script?.textContent) return null;
  const parsed = safeJsonParse(script.textContent);
  const job =
    parsed?.props?.pageProps?.job ||
    parsed?.props?.pageProps?.posting ||
    parsed?.props?.pageProps?.data?.job;

  if (!job) return null;
  const html = job?.descriptionHtml || job?.description || job?.descriptionHTML;
  if (!html) return null;
  return normalizeJobText(extractTextFromHtml(String(html)));
}

function extractFromLever(document, html) {
  const posting = document.querySelector(".posting") || document.querySelector(".posting-page");
  if (posting) return normalizeJobText(posting.textContent || "");

  const match = html.match(/window\.__lever__\s*=\s*(\{[\s\S]*?\});/);
  if (!match) return null;
  const parsed = safeJsonParse(match[1]);
  const text = parsed?.posting?.text || parsed?.posting?.description;
  return text ? normalizeJobText(String(text)) : null;
}

function extractFromGreenhouse(document) {
  const content =
    document.querySelector("#content") ||
    document.querySelector(".content") ||
    document.querySelector("main");
  if (!content) return null;
  return normalizeJobText(content.textContent || "");
}

function extractFromWorkday(document, html) {
  const script = Array.from(document.querySelectorAll('script[type="application/json"]')).find(
    (item) => item.textContent && item.textContent.includes("jobPostingInfo")
  );
  if (script?.textContent) {
    const parsed = safeJsonParse(script.textContent);
    const job = parsed?.jobPostingInfo || parsed?.data?.jobPostingInfo;
    const description = job?.jobDescription || job?.jobDescriptionHtml;
    if (description) return normalizeJobText(extractTextFromHtml(String(description)));
  }

  const text = extractTextFromHtml(html);
  return text ? normalizeJobText(text) : null;
}

function extractFromATS(document, html, url) {
  const hostname = url ? new URL(url).hostname : "";

  if (hostname.includes("ashbyhq.com")) {
    const text = extractFromAshby(document);
    if (text) return { text, method: "ats-ashby" };
  }

  if (hostname.includes("lever.co")) {
    const text = extractFromLever(document, html);
    if (text) return { text, method: "ats-lever" };
  }

  if (hostname.includes("greenhouse.io")) {
    const text = extractFromGreenhouse(document);
    if (text) return { text, method: "ats-greenhouse" };
  }

  if (hostname.includes("myworkdayjobs.com") || hostname.includes("workday")) {
    const text = extractFromWorkday(document, html);
    if (text) return { text, method: "ats-workday" };
  }

  return null;
}

function extractWithReadability(html, url) {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  if (!article?.textContent) return null;
  return normalizeJobText(article.textContent);
}

function parseJobTextFromHtml({ html, url, sourceLabel = "direct" }) {
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;

  const jsonLd = extractJsonLdJobPosting(document);
  if (jsonLd && jsonLd.length >= 200) {
    return { text: jsonLd, method: "jsonld" };
  }

  const ats = extractFromATS(document, html, url);
  if (ats?.text && ats.text.length >= 200) {
    return ats;
  }

  const readability = extractWithReadability(html, url);
  if (readability && readability.length >= 200) {
    return { text: readability, method: "readability" };
  }

  const meta = extractMetaDescription(document);
  if (meta && meta.length >= 200) {
    return { text: meta, method: "meta" };
  }

  const plain = normalizeJobText(extractTextFromHtml(html));
  return { text: plain, method: sourceLabel };
}

async function fetchJobText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml"
    }
  });

  if (response.ok) {
    const html = await response.text();
    const parsed = parseJobTextFromHtml({ html, url, sourceLabel: "direct" });
    if (parsed?.text && parsed.text.length >= 200) {
      return { text: parsed.text.slice(0, 12000), method: parsed.method };
    }
  }

  const jinaUrl = url.startsWith("https://")
    ? `https://r.jina.ai/https://${url.slice("https://".length)}`
    : `https://r.jina.ai/http://${url.slice("http://".length)}`;
  const jinaResponse = await fetch(jinaUrl);
  if (jinaResponse.ok) {
    const jinaText = await jinaResponse.text();
    const normalized = normalizeJobText(jinaText);
    if (normalized && normalized.length >= 200) {
      return { text: normalized.slice(0, 12000), method: "jina" };
    }
  }

  const doubleJinaUrl = url.startsWith("https://")
    ? `https://r.jina.ai/http://r.jina.ai/https://${url.slice("https://".length)}`
    : `https://r.jina.ai/http://r.jina.ai/http://${url.slice("http://".length)}`;
  const doubleResponse = await fetch(doubleJinaUrl);
  if (!doubleResponse.ok) {
    throw new Error(`Failed to fetch page. Status ${response.status}`);
  }
  const doubleText = await doubleResponse.text();
  const doubleNormalized = normalizeJobText(doubleText);

  if (!doubleNormalized || doubleNormalized.length < 200) {
    throw new Error("Not enough readable text found on the page.");
  }

  return { text: doubleNormalized.slice(0, 12000), method: "jina-double" };
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

function extractSignals(jobText) {
  const text = (jobText || "").toLowerCase();
  const has = (pattern) => pattern.test(text);
  const tags = [];

  const addTag = (tag) => {
    if (!tags.includes(tag)) tags.push(tag);
  };

  if (has(/\b(b2b|business[- ]to[- ]business)\b/)) addTag("b2b");
  if (has(/\b(enterprise|large[- ]scale|regulated|compliance)\b/)) addTag("enterprise");
  if (has(/\b(consumer|b2c|consumer[- ]facing)\b/)) addTag("consumer");
  if (has(/\b(saas|subscription)\b/)) addTag("saas");

  if (has(/\b(mobile|ios|android)\b/)) addTag("mobile");
  if (has(/\b(web|responsive|dashboard)\b/)) addTag("web");
  if (has(/\b(multi[- ]platform|cross[- ]platform)\b/)) addTag("multi-platform");

  if (has(/\b(design system|design systems|component library)\b/)) addTag("design systems");
  if (has(/\b(user research|ux research|research)\b/)) addTag("research");
  if (has(/\b(metrics|kpi|conversion|experimentation|ab test|a\/b)\b/)) addTag("metrics & experimentation");
  if (has(/\b(accessibility|a11y|wcag)\b/)) addTag("accessibility");

  if (has(/\b(stakeholder|stakeholders)\b/)) addTag("stakeholder management");
  if (has(/\b(cross[- ]functional|product manager|engineering|marketing|data)\b/)) addTag("cross-functional");
  if (has(/\b(leadership|influence|strategy)\b/)) addTag("leadership");

  let domain = "unknown";
  if (tags.includes("b2b")) domain = "b2b";
  else if (tags.includes("enterprise")) domain = "enterprise";
  else if (tags.includes("saas")) domain = "saas";
  else if (tags.includes("consumer")) domain = "consumer";

  const managerSignals = has(/\b(manager|management|people manager|hiring|mentorship|mentoring|performance reviews)\b/);
  const icSignals = has(/\b(individual contributor|ic)\b/);
  let roleType = "unknown";
  if (managerSignals && icSignals) roleType = "mixed";
  else if (managerSignals) roleType = "manager";
  else if (icSignals) roleType = "ic";

  return { signals: tags.slice(0, 10), domain, role_type: roleType };
}

function inferFocusFromText(jobText) {
  const text = (jobText || "").toLowerCase();
  const has = (pattern) => pattern.test(text);

  if (has(/\b(brand|visual identity|graphic|marketing design|campaign)\b/)) {
    return "brand & visual design";
  }
  if (has(/\b(design system|design systems|component library)\b/)) {
    return "design systems";
  }
  if (has(/\b(user research|ux research|research)\b/)) {
    return "research-heavy";
  }
  if (has(/\b(growth|conversion|activation|retention|funnel)\b/)) {
    return "growth";
  }
  if (has(/\b(product designer|product design|ux\/ui|ux|ui)\b/)) {
    return "product design";
  }

  return "product design";
}

async function callOpenAI(jobText) {
  if (!OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY in environment.");
  }

  const heuristicLevel = inferSeniorityFromText(jobText);
  const extracted = extractSignals(jobText);
  const heuristicFocus = inferFocusFromText(jobText);
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
        role_type: {
          type: "string",
          enum: ["ic", "manager", "mixed", "unknown"]
        },
        domain: {
          type: "string",
          enum: ["b2b", "consumer", "enterprise", "saas", "unknown"]
        },
        focus: { type: "string" },
        signals: {
          type: "array",
          minItems: 0,
          maxItems: 10,
          items: { type: "string" }
        },
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
      required: ["role_level", "role_type", "domain", "focus", "signals", "themes"]
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
      instructions: `${SYSTEM_PROMPT}\nHeuristic seniority hint from text (may be unknown): ${heuristicLevel}. If the posting explicitly names a level, prioritize that.\nHeuristic focus hint: ${heuristicFocus}.\nDetected signals: ${extracted.signals.join(", ") || "none"}.\nDetected domain: ${extracted.domain}. Detected role type: ${extracted.role_type}. Use these signals explicitly in the themes and questions.`,
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

  let final = parsed;

  if (final.role_level === "unknown" && heuristicLevel !== "unknown") {
    final = { ...final, role_level: heuristicLevel };
  }

  if (final.role_type === "unknown" && extracted.role_type !== "unknown") {
    final = { ...final, role_type: extracted.role_type };
  }

  if (final.domain === "unknown" && extracted.domain !== "unknown") {
    final = { ...final, domain: extracted.domain };
  }

  if (!final.focus || final.focus.trim() === "" || final.focus.trim().toLowerCase() === "unknown") {
    final = { ...final, focus: heuristicFocus };
  }

  const parsedSignals = Array.isArray(final.signals) ? final.signals : [];
  const mergedSignals = [...parsedSignals, ...extracted.signals].filter(
    (value, index, array) => value && array.indexOf(value) === index
  );
  final = { ...final, signals: mergedSignals.slice(0, 10) };

  return final;
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
      let parseMeta = { method: "unknown", length: 0 };
      if (rawText && typeof rawText === "string" && rawText.trim().length >= 200) {
        jobText = normalizeJobText(rawText);
        parseMeta = { method: "pasted", length: jobText.length };
      } else if (url && isValidHttpUrl(url)) {
        jobLinks.push({
          title: new URL(url).hostname,
          url,
          createdAt: new Date().toISOString(),
          createdAtMs: Date.now()
        });
        await persistJobLinks();
        const parsed = await fetchJobText(url);
        jobText = parsed.text;
        parseMeta = { method: parsed.method || "direct", length: jobText.length };
      } else {
        return sendJson(res, 400, { error: "Please provide a valid URL or paste the job text." });
      }

      const analysis = await callOpenAI(jobText);

      return sendJson(res, 200, { analysis, parse: parseMeta });
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

function renderAnalyticsPage() {
  const total = analytics.totalVisits;
  const updated = analytics.lastUpdated
    ? new Date(analytics.lastUpdated).toLocaleString("en-US")
    : "Never";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Analytics</title>
    <style>
      :root {
        color-scheme: dark;
      }
      body {
        margin: 0;
        font-family: "Helvetica Neue", Arial, sans-serif;
        background: #0f1115;
        color: #f5f7ff;
      }
      .wrap {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 32px;
      }
      .card {
        width: min(520px, 100%);
        background: #171a21;
        border-radius: 16px;
        padding: 28px;
        box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
        border: 1px solid rgba(255, 255, 255, 0.08);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 22px;
        letter-spacing: 0.02em;
      }
      .metric {
        font-size: 56px;
        font-weight: 700;
        margin: 8px 0 16px;
      }
      .label {
        font-size: 14px;
        text-transform: uppercase;
        letter-spacing: 0.16em;
        color: #9aa3b2;
      }
      .updated {
        font-size: 14px;
        color: #9aa3b2;
      }
      .note {
        margin-top: 18px;
        font-size: 12px;
        color: #6f7785;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <div class="label">Total visits</div>
        <div class="metric">${total}</div>
        <div class="updated">Last updated: ${updated}</div>
        <div class="note">Counts visits to "/" and "/index.html".</div>
      </div>
    </div>
  </body>
</html>`;
}

function renderLinksPage() {
  const rows = jobLinks
    .slice()
    .reverse()
    .map((item) => {
      const date = item?.createdAt
        ? new Date(item.createdAt).toLocaleString("en-US")
        : "—";
      const title = item?.title || "Untitled";
      const url = item?.url || "";
      return `<tr>
        <td>${date}</td>
        <td>${title}</td>
        <td><a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a></td>
      </tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Job Links</title>
    <style>
      :root {
        color-scheme: dark;
      }
      body {
        margin: 0;
        font-family: "Helvetica Neue", Arial, sans-serif;
        background: #0f1115;
        color: #f5f7ff;
      }
      .wrap {
        min-height: 100vh;
        padding: 32px;
      }
      h1 {
        margin: 0 0 18px;
        font-size: 22px;
        letter-spacing: 0.02em;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        background: #171a21;
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
        border: 1px solid rgba(255, 255, 255, 0.08);
      }
      th, td {
        text-align: left;
        padding: 14px 16px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        font-size: 14px;
      }
      th {
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: #9aa3b2;
        font-size: 12px;
      }
      tr:last-child td {
        border-bottom: none;
      }
      a {
        color: #8cc7ff;
        word-break: break-all;
      }
      .empty {
        padding: 24px;
        color: #9aa3b2;
        background: #171a21;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.08);
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>Saved Job Links (${jobLinks.length})</h1>
      ${
        rows
          ? `<table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Title</th>
                  <th>URL</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>`
          : `<div class="empty">No links saved yet.</div>`
      }
    </div>
  </body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url.startsWith("/api/analyze")) {
    return handleApiAnalyze(req, res);
  }

  if (req.method === "GET" && req.url.startsWith("/admin/analytics")) {
    return sendHtml(res, 200, renderAnalyticsPage());
  }

  if (req.method === "GET" && req.url.startsWith("/admin/links")) {
    return sendHtml(res, 200, renderLinksPage());
  }

  if (req.method === "GET") {
    const pathOnly = req.url.split("?")[0];
    if (pathOnly === "/" || pathOnly === "/index.html") {
      analytics.totalVisits += 1;
      await persistAnalytics();
    }
    return serveStatic(req, res);
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method not allowed");
});

await loadAnalytics();
await loadJobLinks();
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
