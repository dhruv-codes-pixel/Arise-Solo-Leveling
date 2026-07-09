// supabase/functions/groq-proxy/index.ts
//
// Thin server-side proxy so no AI provider key ever reaches the browser.
// Arise's client (index.html) POSTs { prompt: string } here; this function
// calls Groq first, and — ONLY if Groq fails or is rate-limited — transparently
// falls back to Gemini (free tier) server-side, then returns { text } (or
// { error }). The client never knows or cares which provider actually
// answered; the response shape is identical either way, so nothing in
// index.html needs to change for the fallback to work.
//
// Deploy:
//   supabase functions deploy groq-proxy --no-verify-jwt
//   supabase secrets set GROQ_API_KEY=gsk_your_groq_key_here
//   supabase secrets set GEMINI_API_KEY=your_gemini_key_here   (optional — backup only)
//
// --no-verify-jwt is used because Arise calls this with the public anon key
// only (no per-user login flow in this app). If you later add Supabase Auth
// to Arise, drop that flag and this function will require a valid user JWT.
//
// Fallback behavior:
//   1. Try Groq (GROQ_MODEL below), with a short server-side timeout.
//   2. If Groq errors, times out, or returns a non-2xx (e.g. 429 rate limit
//      exceeded, 5xx outage) AND GEMINI_API_KEY is set, retry the exact same
//      prompt against Gemini (GEMINI_MODEL below).
//   3. If GEMINI_API_KEY isn't set, or Gemini also fails, return the same
//      { error } shape as before — every caller in index.html already
//      treats any non-2xx / missing-text response as "fail silently".

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile"; // change if you prefer a different Groq model

const GEMINI_MODEL = "gemini-2.0-flash"; // free-tier Gemini model used for backup only
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const MAX_TOKENS = 220;
const TEMPERATURE = 0.8;

// Keep each provider attempt well under the client's own 7-9s abort timeout
// (see _callGroqProxy() in index.html) so a Groq failure still leaves time
// for a Gemini retry to land before the client gives up.
const GROQ_TIMEOUT_MS = 6000;
const GEMINI_TIMEOUT_MS = 5000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Returns the reply text on success, or null on any failure (network error,
// timeout, non-2xx, empty completion). Never throws.
async function callGroq(prompt: string, groqKey: string): Promise<string | null> {
  try {
    const resp = await fetchWithTimeout(
      GROQ_URL,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${groqKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [{ role: "user", content: prompt }],
          max_tokens: MAX_TOKENS,
          temperature: TEMPERATURE,
        }),
      },
      GROQ_TIMEOUT_MS,
    );

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error("Groq request failed:", resp.status, errText);
      return null;
    }

    const data = await resp.json();
    const text: string = data?.choices?.[0]?.message?.content?.trim() ?? "";
    return text || null;
  } catch (e) {
    console.error("Groq request error:", e);
    return null;
  }
}

// Same contract as callGroq(): text on success, null on any failure.
async function callGemini(prompt: string, geminiKey: string): Promise<string | null> {
  try {
    const resp = await fetchWithTimeout(
      `${GEMINI_URL}?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: MAX_TOKENS,
            temperature: TEMPERATURE,
          },
        }),
      },
      GEMINI_TIMEOUT_MS,
    );

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error("Gemini request failed:", resp.status, errText);
      return null;
    }

    const data = await resp.json();
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
    return text || null;
  } catch (e) {
    console.error("Gemini request error:", e);
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: { prompt?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const prompt = body?.prompt;
  if (!prompt || typeof prompt !== "string" || prompt.length > 8000) {
    return jsonResponse({ error: "Missing or invalid 'prompt'" }, 400);
  }

  const groqKey = Deno.env.get("GROQ_API_KEY");
  const geminiKey = Deno.env.get("GEMINI_API_KEY"); // optional — backup only

  if (!groqKey && !geminiKey) {
    return jsonResponse({ error: "Server not configured (GROQ_API_KEY missing)" }, 500);
  }

  // 1. Try Groq first (primary provider).
  if (groqKey) {
    const text = await callGroq(prompt, groqKey);
    if (text) return jsonResponse({ text, provider: "groq" });
  }

  // 2. Groq failed, errored, timed out, or was rate-limited — fall back to
  //    Gemini if a backup key is configured. Same prompt, same contract.
  if (geminiKey) {
    const text = await callGemini(prompt, geminiKey);
    if (text) return jsonResponse({ text, provider: "gemini" });
  }

  // 3. Both providers failed (or only one was configured and it failed).
  return jsonResponse({ error: "AI request failed on all configured providers" }, 502);
});
