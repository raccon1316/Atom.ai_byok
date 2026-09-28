// ai.js
//
// AUTH ARCHITECTURE (verified 2026-09-26): BYOK — the user supplies their own
// Groq key. An earlier design posted to a Vercel proxy
// (atom-ai-eight.vercel.app/api/chat) that authenticated on the X-Extension-Id
// header alone and held the provider key server-side. That proxy is gone from
// this repo — there is no /api/ folder and no vercel.json; it survives only in
// stale editor backups under .history/ — and nothing references it. Both AI
// instances (background.js, popup.js) are constructed with getApiKey reading
// the user's stored key, requestCompletion() sends it as
// `Authorization: Bearer ${apiKey}` straight to api.groq.com, and the
// "No Groq API key set" guard at the top of requestCompletion() fails a
// keyless user fast and locally, before the quota check and before any fetch.
// Consequence: the Bearer header is REQUIRED, and extractErrorMessage's 401
// text still points at the Groq console because the user is the one who can
// fix their key.

// Per-attempt ceiling for a single provider request. A stalled connection used to
// hang requestCompletion() forever, which blocks the whole job pipeline behind it
// (the SW is single-threaded), so every attempt is now bounded.
export const AI_TIMEOUT_MS = 30000;

export class AI {
  constructor({ getApiKey, getModel, onCall }) {
    this.getApiKey = getApiKey;
    this.getModel = getModel;
    this.onCall = onCall;
  }

  async checkLimit() {
    if (!this.onCall) return true;
    const result = await this.onCall();
    if (typeof result === "boolean") {
      if (!result) throw new Error("Usage limit reached. Please try later.");
      return true;
    }
    if (result && typeof result === "object") {
      if (result.allowed === false) {
        throw new Error(result.reason || "Usage limit reached. Please try later.");
      }
      return true;
    }
    if (!result) throw new Error("Usage limit reached. Please try later.");
    return true;
  }

  buildEndpoint() {
    return "https://api.groq.com/openai/v1/chat/completions";
  }

  async safeParseResponse(res) {
    const raw = await res.text();
    if (!raw || !raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch (e) {
      return { _raw: raw };
    }
  }

  extractErrorMessage(status, data) {
    const providerError = data?.error?.message || data?.error || "";
    if (typeof providerError === "string" && providerError.trim()) return providerError.trim();
    if (status === 401) {
      return "Invalid Groq API key. Check it in Settings, or get one at https://console.groq.com/keys.";
    }
    if (status === 402) {
      return "Groq API rejected the request (insufficient credits or account access). Check your key at https://console.groq.com/keys.";
    }
    if (status === 429) {
      return "Rate limited by Groq. Wait a moment and try again.";
    }
    const detail = typeof data?._raw === "string" ? data._raw.slice(0, 220) : "";
    if (detail) return `AI request failed (${status}): ${detail}`;
    return `AI request failed with status ${status}`;
  }

  async requestCompletion({ messages, maxTokens = 600, temperature = 0.3, retries = 2, onProgress, timeoutMs, json }) {
    const apiKey = await this.getApiKey();
    if (!apiKey || !apiKey.trim()) {
      throw new Error("No Groq API key set. Add one in Settings to use AI features.");
    }

    await this.checkLimit();

    const requestedModel = this.getModel();
    const model = validateModel(requestedModel);
    const endpoint = this.buildEndpoint();
    // Transcript-sized analyses legitimately run far longer than the 30s
    // default, so callers can raise the per-attempt ceiling per call. The
    // default stays tight: it exists to keep one stalled socket from wedging
    // the single-threaded job pipeline.
    const perAttemptMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : AI_TIMEOUT_MS;
    const body = {
      model,
      max_tokens: maxTokens,
      temperature,
      messages
    };
    // json:true asks the provider for guaranteed JSON output. Optional because
    // not every model supports response_format — structured.js falls back to a
    // prompt-only retry when the provider rejects it.
    if (json) body.response_format = { type: "json_object" };

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      // Long calls (company briefs, deep research) can sit for many seconds with
      // no visible feedback, so the caller's onProgress hook gets a heartbeat
      // that is genuinely wired to the request lifecycle.
      if (onProgress) {
        try { onProgress(attempt === 0 ? "⏳ Waiting for AI response…" : `⏳ Retrying (attempt ${attempt + 1}/${retries + 1})…`); } catch (e) {}
      }
      // Each attempt gets its own controller so a retry is never aborted by the
      // previous attempt's timer. Without this, a stalled socket hangs the whole
      // job pipeline forever: the job queue is single-threaded behind this call.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), perAttemptMs);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        const data = await this.safeParseResponse(res);
        if (!res.ok) {
          throw new Error(this.extractErrorMessage(res.status, data));
        }
        if (data?.error) {
          throw new Error(this.extractErrorMessage(res.status, data));
        }
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text !== "string" || !text.trim()) {
          throw new Error("AI returned an empty response");
        }
        if (onProgress) { try { onProgress("📥 Processing response…"); } catch (e) {} }
        return text;
      } catch (e) {
        // A timeout is worth retrying like any other transient failure, but the
        // surfaced message must not be a bare "The user aborted a request".
        lastError = e && e.name === "AbortError"
          ? new Error(`AI request timed out after ${perAttemptMs / 1000} seconds. Check your connection and try again.`)
          : e;
        if (attempt === retries) break;
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      } finally {
        // Always clear, including on the success return above, so a completed
        // call cannot leave a timer holding the SW awake for 30s.
        clearTimeout(timeoutId);
      }
    }
    throw lastError || new Error("AI call failed after retries");
  }

  // onProgress is forwarded so the progress heartbeat is reachable from the
  // long-running briefs, which go through chat()/chatWithMessages() — research.js
  // alone makes a dozen .chat() calls for company/person/market briefs. Without
  // the pass-through the hook existed but no real caller could use it.
  async chat(prompt, maxTokens = 600, temperature = 0.3, retries = 2, onProgress) {
    return await this.requestCompletion({
      messages: [{ role: "user", content: prompt }],
      maxTokens,
      temperature,
      retries,
      onProgress
    });
  }

  async chatWithMessages(messages, maxTokens = 600, temperature = 0.3, retries = 1, onProgress) {
    if (!Array.isArray(messages) || !messages.length) {
      throw new Error("Messages are required for chatWithMessages");
    }
    return await this.requestCompletion({
      messages,
      maxTokens,
      temperature,
      retries,
      onProgress
    });
  }
}

function validateModel(model) {
    const supportedModels = ["openai/gpt-oss-20b", "openai/gpt-oss-120b"];
    const defaultModel = "openai/gpt-oss-20b";
    
    if (!model || typeof model !== "string") {
        return defaultModel;
    }
    
    if (supportedModels.includes(model)) {
        return model;
    }
    
    // Migrate known deprecated models
    if (model === "llama3-8b-8192") {
        return defaultModel;
    }
    
    // For any other unsupported model, default to the recommended one
    return defaultModel;
}
