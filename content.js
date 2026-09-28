/* ================================================================
   ATOM.AI — Content Script
   Floating pill button + Text selection toolbar
   ================================================================ */

// API calls routed through background.js (chrome.runtime.sendMessage)

/* ── Inject styles ── */
const style = document.createElement("style");
style.textContent = `
  #atom-fab {
    position: fixed;
    bottom: 28px;
    right: 28px;
    z-index: 2147483646;
    background: linear-gradient(135deg, #6c63ff, #00d4a8);
    color: #fff;
    border: none;
    border-radius: 50px;
    padding: 10px 18px;
    font-size: 13px;
    font-weight: 700;
    font-family: 'Inter', system-ui, sans-serif;
    cursor: pointer;
    box-shadow: 0 4px 20px rgba(108,99,255,0.45);
    display: flex;
    align-items: center;
    gap: 7px;
    transition: all 0.2s;
    user-select: none;
    letter-spacing: 0.3px;
  }
  #atom-fab:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 28px rgba(108,99,255,0.6);
  }
  #atom-fab.minimized {
    padding: 10px 13px;
    border-radius: 50%;
  }
  #atom-fab.minimized .atom-fab-label { display: none; }

  #atom-toolbar {
    position: fixed;
    z-index: 2147483647;
    background: #0f0f18;
    border: 1px solid #28283f;
    border-radius: 10px;
    padding: 6px;
    display: none;
    gap: 4px;
    flex-wrap: wrap;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    max-width: 320px;
    animation: atomFadeIn 0.15s ease;
  }
  #atom-toolbar.visible { display: flex; }
  @keyframes atomFadeIn {
    from { opacity:0; transform:translateY(4px); }
    to   { opacity:1; transform:translateY(0); }
  }
  .atom-tool-btn {
    background: #14141f;
    border: 1px solid #28283f;
    color: #9898b8;
    border-radius: 7px;
    padding: 5px 10px;
    font-size: 11px;
    font-weight: 700;
    font-family: 'Inter', system-ui, sans-serif;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }
  .atom-tool-btn:hover {
    background: rgba(108,99,255,0.15);
    border-color: #6c63ff;
    color: #6c63ff;
  }

  #atom-panel {
    position: fixed;
    bottom: 90px;
    right: 28px;
    z-index: 2147483646;
    width: 340px;
    background: #0f0f18;
    border: 1px solid #28283f;
    border-radius: 14px;
    box-shadow: 0 12px 48px rgba(0,0,0,0.6);
    display: none;
    flex-direction: column;
    overflow: hidden;
    animation: atomFadeIn 0.2s ease;
    font-family: 'Inter', system-ui, sans-serif;
  }
  #atom-panel.visible { display: flex; }

  #atom-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    background: #14141f;
    border-bottom: 1px solid #1e1e30;
  }
  #atom-panel-title {
    font-size: 12px;
    font-weight: 700;
    background: linear-gradient(135deg, #6c63ff, #00d4a8);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    letter-spacing: 0.5px;
  }
  #atom-panel-close {
    background: none;
    border: none;
    color: #4a4a6a;
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0 2px;
  }
  #atom-panel-close:hover { color: #9898b8; }

  #atom-panel-body {
    padding: 12px 14px;
    max-height: 300px;
    overflow-y: auto;
    font-size: 12px;
    line-height: 1.7;
    color: #e8e8f0;
    white-space: pre-wrap;
    word-break: break-word;
  }
  #atom-panel-body::-webkit-scrollbar { width: 3px; }
  #atom-panel-body::-webkit-scrollbar-thumb { background: #28283f; border-radius: 2px; }

  #atom-panel-input-row {
    display: flex;
    gap: 6px;
    padding: 10px 14px;
    border-top: 1px solid #1e1e30;
    background: #14141f;
  }
  #atom-panel-input {
    flex: 1;
    background: #1a1a28;
    border: 1px solid #28283f;
    border-radius: 7px;
    color: #e8e8f0;
    font-size: 12px;
    font-family: 'Inter', system-ui, sans-serif;
    padding: 7px 10px;
    outline: none;
    transition: border-color 0.2s;
  }
  #atom-panel-input:focus { border-color: #6c63ff; }
  #atom-panel-input::placeholder { color: #4a4a6a; }
  #atom-panel-send {
    background: linear-gradient(135deg, #6c63ff, #8b5cf6);
    border: none;
    border-radius: 7px;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    padding: 7px 12px;
    cursor: pointer;
    font-family: 'Inter', system-ui, sans-serif;
    transition: filter 0.15s;
  }
  #atom-panel-send:hover { filter: brightness(1.15); }

  #atom-panel-actions {
    display: flex;
    gap: 4px;
    padding: 8px 14px;
    border-top: 1px solid #1e1e30;
    flex-wrap: wrap;
  }
  .atom-action-chip {
    background: #14141f;
    border: 1px solid #28283f;
    color: #9898b8;
    border-radius: 20px;
    padding: 4px 10px;
    font-size: 10px;
    font-weight: 600;
    cursor: pointer;
    font-family: 'Inter', system-ui, sans-serif;
    transition: all 0.15s;
    white-space: nowrap;
  }
  .atom-action-chip:hover {
    border-color: #6c63ff;
    color: #6c63ff;
    background: rgba(108,99,255,0.12);
  }

  #atom-loader {
    padding: 8px 0;
    font-size: 11px;
    color: #6c63ff;
    font-family: 'JetBrains Mono', monospace;
    animation: atomPulse 1.2s infinite;
    display: none;
  }
  @keyframes atomPulse { 0%,100%{opacity:1} 50%{opacity:0.3} }

  .atom-replace-btn {
    background: rgba(0,212,168,0.12);
    border: 1px solid rgba(0,212,168,0.3);
    color: #00d4a8;
    border-radius: 7px;
    padding: 5px 10px;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    font-family: 'Inter', system-ui, sans-serif;
    margin-top: 8px;
    display: none;
  }
`;
document.head.appendChild(style);

/* ================================================================
   BUILD UI ELEMENTS
   ================================================================ */

/* Floating pill button */
const fab = document.createElement("button");
fab.id = "atom-fab";
fab.innerHTML = `✦ <span class="atom-fab-label">Atom.AI</span>`;
document.body.appendChild(fab);

/* Text selection toolbar */
const toolbar = document.createElement("div");
toolbar.id = "atom-toolbar";
toolbar.innerHTML = `
  <button class="atom-tool-btn" data-action="summarize">📄 Summarize</button>
  <button class="atom-tool-btn" data-action="explain">🧑‍🏫 Explain</button>
  <button class="atom-tool-btn" data-action="rewrite">✏️ Rewrite</button>
  <button class="atom-tool-btn" data-action="translate">🌐 Translate</button>
  <button class="atom-tool-btn" data-action="extract">📋 Extract Data</button>
  <button class="atom-tool-btn" data-action="email">📧 Write Email</button>
`;
let toolbarMounted = false;

/* Side panel */
const panel = document.createElement("div");
panel.id = "atom-panel";
panel.innerHTML = `
  <div id="atom-panel-header">
    <span id="atom-panel-title">✦ ATOM.AI</span>
    <button id="atom-panel-close">✕</button>
  </div>
  <div id="atom-panel-body">👋 Ask me anything about this page, or select text to use quick tools.</div>
  <div id="atom-loader">⚡ Thinking...</div>
  <div id="atom-company-bar" style="padding:8px 14px 0;display:none;">
    <div id="atom-detected-company" style="font-size:11px;color:#9898b8;margin-bottom:6px;"></div>
    <button id="atom-quick-research" style="width:100%;background:linear-gradient(135deg,#6c63ff,#00d4a8);border:none;border-radius:8px;color:#fff;font-size:12px;font-weight:700;padding:9px;cursor:pointer;font-family:Inter,system-ui,sans-serif;letter-spacing:0.3px;">⚡ Research This Company</button>
  </div>
  <div id="atom-panel-actions">
    <span class="atom-action-chip" data-page="summarize">📄 Summarize</span>
    <span class="atom-action-chip" data-page="leads">📋 Leads</span>
    <span class="atom-action-chip" data-page="emails">📧 Emails</span>
    <span class="atom-action-chip" data-page="techstack">🛠️ Stack</span>
    <span class="atom-action-chip" data-page="sentiment">💬 Sentiment</span>
    <span class="atom-action-chip" data-page="keypoints">🎯 Key Points</span>
  </div>
  <div id="atom-panel-input-row">
    <input id="atom-panel-input" placeholder="Ask about this page..." />
    <button id="atom-panel-send">Send</button>
  </div>
`;
let uiInjected = false;

function injectUI() {
  if (uiInjected) return;
  document.body.appendChild(toolbar);
  document.body.appendChild(panel);
  uiInjected = true;
}

/* ================================================================
   STATE
   ================================================================ */

let panelOpen = false;
let lastSelectedText = "";
let panelChatHistory = [];
let fabMinimized = false;

/* ================================================================
   AI HELPER (content script version) — UPDATED
   ================================================================ */

async function atomAI(prompt, maxTokens = 600, model = "openai/gpt-oss-20b") {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: "AI_CHAT", prompt, maxTokens },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve("Error: " + chrome.runtime.lastError.message);
          } else {
            resolve(response?.text || "No response.");
          }
        }
      );
    } catch(e) {
      resolve("Error connecting to AI: " + e.message);
    }
  });
}

function getPageContent() {
  const clone = document.body?.cloneNode(true);
  if (clone) {
    clone.querySelectorAll("script,style,noscript,template").forEach((el) => el.remove());
  }
  const el = clone?.querySelector("article") ||
             clone?.querySelector("main") ||
             clone?.querySelector("[role='main']") ||
             clone ||
             document.body;
  return (document.title + "\n\n" + (el?.innerText || "")).replace(/\s+/g, " ").trim().substring(0, 4000);
}

function showLoader(show) {
  document.getElementById("atom-loader").style.display = show ? "block" : "none";
}

function setPanelBody(text) {
  document.getElementById("atom-panel-body").innerText = text;
  showLoader(false);
}

function appendPanelBody(text) {
  const body = document.getElementById("atom-panel-body");
  body.innerText += (body.innerText ? "\n\n" : "") + text;
  body.scrollTop = body.scrollHeight;
}

/* ================================================================
   FAB — open/close panel
   ================================================================ */

fab.addEventListener("click", (e) => {
  e.stopPropagation();
  injectUI();
  panelOpen = !panelOpen;
  panel.classList.toggle("visible", panelOpen);
  if (panelOpen) {
    fab.innerHTML = `✕ <span class="atom-fab-label">Close</span>`;
  } else {
    fab.innerHTML = `✦ <span class="atom-fab-label">Atom.AI</span>`;
  }
});

/* Double-click fab to minimize to icon only */
fab.addEventListener("dblclick", (e) => {
  e.stopPropagation();
  injectUI();
  fabMinimized = !fabMinimized;
  fab.classList.toggle("minimized", fabMinimized);
  if (fabMinimized) fab.innerHTML = `✦`;
  else fab.innerHTML = `✦ <span class="atom-fab-label">Atom.AI</span>`;
});

panel.querySelector("#atom-panel-close").addEventListener("click", () => {
  panelOpen = false;
  panel.classList.remove("visible");
  fab.innerHTML = `✦ <span class="atom-fab-label">Atom.AI</span>`;
});

/* ================================================================
   TEXT SELECTION TOOLBAR
   ================================================================ */

document.addEventListener("mouseup", (e) => {
  // Don't trigger inside our own UI
  if (e.target.closest("#atom-toolbar") || e.target.closest("#atom-panel") || e.target.closest("#atom-fab")) return;

  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (text && text.length > 15) {
      injectUI();
      if (!toolbarMounted) {
        toolbarMounted = true;
      }
      lastSelectedText = text;
      // Position toolbar near selection
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      toolbar.style.top = (rect.top + window.scrollY - 50) + "px";
      toolbar.style.left = Math.min(rect.left + window.scrollX, window.innerWidth - 340) + "px";
      toolbar.classList.add("visible");
    } else {
      toolbar.classList.remove("visible");
    }
  }, 10);
});

document.addEventListener("mousedown", (e) => {
  if (!e.target.closest("#atom-toolbar")) {
    toolbar.classList.remove("visible");
  }
});

/* Toolbar button actions */
toolbar.querySelectorAll(".atom-tool-btn").forEach(btn => {
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    toolbar.classList.remove("visible");

    if (!panelOpen) {
      panelOpen = true;
      panel.classList.add("visible");
      fab.innerHTML = `✕ <span class="atom-fab-label">Close</span>`;
    }

    const action = btn.dataset.action;
    const text = lastSelectedText;

    showLoader(true);
    document.getElementById("atom-panel-body").innerText = "";

    const prompts = {
      summarize: `Summarize this text concisely in bullet points:\n\n"${text}"`,
      explain:   `Explain this clearly in simple terms, like explaining to a smart non-expert:\n\n"${text}"`,
      rewrite:   `Rewrite this to be clearer, more professional, and more concise. Keep the same meaning:\n\n"${text}"`,
      translate: `Translate this to English (if already English, translate to Spanish). Provide only the translation:\n\n"${text}"`,
      extract:   `Extract all key data points, facts, names, numbers, and entities from:\n\n"${text}"\n\nFormat as a clean structured list.`,
      email:     `Write a professional email based on this content/context:\n\n"${text}"\n\nMake it concise and actionable.`,
    };

    const result = await atomAI(prompts[action]);
    setPanelBody(result);

    // Show replace button if it's an editable field context
    const activeEl = document.activeElement;
    if (action === "rewrite" && activeEl && (activeEl.tagName === "TEXTAREA" || activeEl.isContentEditable || activeEl.tagName === "INPUT")) {
      const replaceBtn = document.createElement("button");
      replaceBtn.className = "atom-replace-btn";
      replaceBtn.style.display = "block";
      replaceBtn.innerText = "↩️ Replace Selected Text";
      replaceBtn.addEventListener("click", () => {
        if (activeEl.tagName === "TEXTAREA" || activeEl.tagName === "INPUT") {
          const start = activeEl.selectionStart;
          const end = activeEl.selectionEnd;
          activeEl.value = activeEl.value.substring(0, start) + result + activeEl.value.substring(end);
        } else if (activeEl.isContentEditable) {
          document.execCommand("insertText", false, result);
        }
        replaceBtn.remove();
      });
      document.getElementById("atom-panel-body").appendChild(replaceBtn);
    }
  });
});

/* ================================================================
   PANEL — quick page action chips
   ================================================================ */

panel.querySelectorAll(".atom-action-chip").forEach(chip => {
  chip.addEventListener("click", async () => {
    const action = chip.dataset.page;
    showLoader(true);
    document.getElementById("atom-panel-body").innerText = "";
    const page = getPageContent();

    const prompts = {
      summarize:  `Summarize this page in clear bullet points for a business professional:\n\n${page}`,
      leads:      `Extract all business leads from this page (names, emails, phones, companies, roles). Format as numbered list:\n\n${page}`,
      emails:     `Find all email addresses on this page. List them clearly:\n\n${page}`,
      techstack:  `Identify the tech stack of this website. List: Frontend, Backend signals, Analytics, CMS, Payment tools, Chat tools:\n\n${page}`,
      sentiment:  `Sentiment analysis: overall tone, emotion, bias direction, and sentiment score /10:\n\n${page}`,
      keypoints:  `Extract the 5 most important business insights from this page. Each must be specific, actionable, and include supporting evidence from the page.\n\n${page}`,
    };

    const result = await atomAI(prompts[action]);
    setPanelBody(result);
  });
});

/* ================================================================
   PANEL — chat input
   ================================================================ */

async function sendPanelChat() {
  const input = document.getElementById("atom-panel-input");
  const q = input.value.trim();
  if (!q) return;
  input.value = "";

  const body = document.getElementById("atom-panel-body");
  body.innerText += (body.innerText ? "\n\n" : "") + "You: " + q;

  showLoader(true);

  const page = getPageContent();
  panelChatHistory.push({ role: "user", content: q });

  const messages = [
    { role: "system", content: `You are a helpful business AI assistant. Answer based on this page:\n\n${page}\n\nBe concise and direct.` },
    ...panelChatHistory.slice(-6),
  ];

  try {
    // Build a single prompt from the messages array for the proxy
    const systemMsg = messages[0]?.content || "";
    const userMsg = messages[messages.length - 1]?.content || q;
    const combinedPrompt = systemMsg + "\n\nUser question: " + userMsg;
    const reply = await atomAI(combinedPrompt, 400);
    panelChatHistory.push({ role: "assistant", content: reply });
    showLoader(false);
    body.innerText += "\n\nAtom: " + reply;
    body.scrollTop = body.scrollHeight;
  } catch(e) {
    showLoader(false);
    body.innerText += "\n\nAtom: Error — " + e.message;
  }
}

panel.querySelector("#atom-panel-send").addEventListener("click", sendPanelChat);
panel.querySelector("#atom-panel-input").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); sendPanelChat(); }
});


/* ================================================================
   DRAGGABLE FAB
   ================================================================ */

let isDragging = false, dragStartX, dragStartY, fabStartX, fabStartY;
function clampUIToViewport() {
  const fabRect = fab.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const fabLeft = Math.max(0, Math.min(window.innerWidth - fabRect.width, fabRect.left));
  const fabTop = Math.max(0, Math.min(window.innerHeight - fabRect.height, fabRect.top));
  fab.style.left = fabLeft + "px";
  fab.style.top = fabTop + "px";
  fab.style.right = "auto";
  fab.style.bottom = "auto";

  if (panel.classList.contains("visible")) {
    const panelLeft = Math.max(0, Math.min(window.innerWidth - panelRect.width, panelRect.left));
    const panelTop = Math.max(0, Math.min(window.innerHeight - panelRect.height, panelRect.top));
    panel.style.left = panelLeft + "px";
    panel.style.top = panelTop + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }
}

fab.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  isDragging = false;
  dragStartX = e.clientX; dragStartY = e.clientY;
  const rect = fab.getBoundingClientRect();
  fabStartX = rect.left; fabStartY = rect.top;

  const onMove = (e) => {
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      isDragging = true;
      fab.style.right = "auto";
      fab.style.bottom = "auto";
      fab.style.left = Math.max(0, Math.min(window.innerWidth - fab.offsetWidth, fabStartX + dx)) + "px";
      fab.style.top = Math.max(0, Math.min(window.innerHeight - fab.offsetHeight, fabStartY + dy)) + "px";
    }
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    // Snap panel position to near fab after drag
    if (isDragging) {
      const fabRect = fab.getBoundingClientRect();
      panel.style.bottom = "auto";
      panel.style.right = "auto";
      const left = Math.max(0, Math.min(fabRect.left, window.innerWidth - 360));
      const top = Math.max(10, Math.min(fabRect.top - 340, window.innerHeight - 380));
      panel.style.left = left + "px";
      panel.style.top = top + "px";
      clampUIToViewport();
    }
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

// Prevent click firing after drag
fab.addEventListener("click", (e) => {
  if (isDragging) { isDragging = false; e.stopImmediatePropagation(); }
});

window.addEventListener("resize", clampUIToViewport);


/* ================================================================
   COMPANY DETECTION — detect if on a company website & show research button
   ================================================================ */

async function detectCompany() {
  const hostname = window.location.hostname
    .replace("www.", "")
    .replace(".com", "").replace(".io", "").replace(".co", "")
    .replace(".net", "").replace(".org", "").replace(".ai", "")
    .split(".")[0];

  // Skip generic sites
  const generic = ["google","youtube","facebook","twitter","instagram","linkedin","reddit","wikipedia","amazon","gmail","outlook","github"];
  if (generic.includes(hostname)) return null;

  // Capitalize nicely
  return hostname.charAt(0).toUpperCase() + hostname.slice(1);
}

async function initCompanyBar() {
  const company = await detectCompany();
  const bar = document.getElementById("atom-company-bar");
  const label = document.getElementById("atom-detected-company");
  const quickBtn = document.getElementById("atom-quick-research");
  if (company && company.length > 1 && bar && label) {
    bar.style.display = "block";
    label.innerText = "🏢 Detected: " + company;
    if (quickBtn) quickBtn.dataset.company = company;
  }
}

// The panel (and this button) is created at the top of this file and appended to
// document.body before this line runs, so the element is present here. The guard
// is defence in depth: a page that blocks the injection, or a future reordering,
// must not take down the whole content script — that would also kill the keyboard
// shortcuts and the company bar below.
document.getElementById("atom-quick-research")?.addEventListener("click", async () => {
  const company = document.getElementById("atom-quick-research").dataset.company;
  if (!company) return;

  const body = document.getElementById("atom-panel-body");
  body.innerText = "";
  showLoader(true);

  // Read current page content as layer 1 (we're already on their site)
  const pageContent = getPageContent();

  // Show live status in panel
  document.getElementById("atom-panel-body").innerText = "🔍 Reading " + company + " website...\n\nExtracting business model, products, target customers...";

  const report = await Promise.race([
    atomAI(`You are a senior B2B sales intelligence analyst. I am ON the website of "${company}".

CRITICAL RULES:
- Be SPECIFIC — use actual facts from the page, not generic statements
- If something is NOT on the page, say "Not found on site"  
- Every section must have at least one specific detail from the content below

PAGE CONTENT:
${pageContent.substring(0, 3500)}

Write a SALES INTELLIGENCE BRIEF:

⚡ SALES BRIEF — ${company.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━

🏢 WHAT THEY DO
[One precise sentence: what they sell + who buys it + what pain it solves]

💰 BUSINESS MODEL
[How they charge: SaaS/one-time/freemium/enterprise? Any pricing found on site?]

🔥 PAIN POINTS (3 specific, not generic)
[Base on their messaging — what problems do THEY say they solve?]

👤 WHO TO TALK TO
[Based on their team/about page: roles, titles, decision makers]

🎯 YOUR OPENING LINE
[Reference ONE specific thing from their website — a feature, a claim, a recent launch]

⚠️ DO NOT SAY
[2 things based on their positioning that would kill trust]

📊 CONFIDENCE: [X/100] — [one line on data quality]`, 900),
    new Promise(r => setTimeout(() => r("⚠️ Research timed out. Try again."), 20000))
  ]);

  setPanelBody(report);

  // Add copy/export buttons
  const actBar = document.createElement("div");
  actBar.style.cssText = "display:flex;gap:6px;padding:8px 14px;border-top:1px solid #1e1e30;flex-wrap:wrap;";
  actBar.innerHTML = `
    <button onclick="navigator.clipboard.writeText(document.getElementById('atom-panel-body').innerText)" style="background:#14141f;border:1px solid #28283f;color:#9898b8;border-radius:6px;padding:4px 10px;font-size:10px;font-weight:700;cursor:pointer;font-family:Inter,sans-serif;">📋 Copy</button>
    <button id="atom-save-report" style="background:#14141f;border:1px solid #28283f;color:#9898b8;border-radius:6px;padding:4px 10px;font-size:10px;font-weight:700;cursor:pointer;font-family:Inter,sans-serif;">💾 Save</button>
  `;
  document.getElementById("atom-panel").insertBefore(actBar, document.getElementById("atom-panel-input-row"));

  document.getElementById("atom-save-report").addEventListener("click", () => {
    // Send to extension storage via background
    chrome.runtime.sendMessage({
      type: "SAVE_REPORT",
      payload: { topic: company, report, type: "company", savedAt: new Date().toLocaleString(), url: location.href }
    });
    document.getElementById("atom-save-report").innerText = "✅ Saved!";
  });
});

// Init company bar when panel opens
const origFabClick = fab.onclick;
fab.addEventListener("click", () => {
  if (!panelOpen) initCompanyBar();
});

/* ================================================================
   LINKEDIN AUTO-BRIEF (F2)
   On /in/* and /company/* pages, extract name/title/company and relay
   to the SW, which parks it for the popup banner. LinkedIn is an SPA,
   so navigation happens without loads — re-scan after clicks and
   popstate. Every failure is silent by design: no banner is better
   than a broken one.
   ================================================================ */
let __atomLastLinkedInSig = "";
async function __atomScanLinkedIn() {
  try {
    // Content scripts are classic scripts; the shared extractor is a module
    // loaded through the extension's own URL.
    const mod = await import(chrome.runtime.getURL("linkedin.js"));
    const ctx = mod.extractLinkedInContext(document, location.href);
    if (!ctx) return;
    const sig = ctx.kind + "|" + ctx.name + "|" + ctx.url.split("?")[0];
    if (sig === __atomLastLinkedInSig) return; // unchanged — don't re-store
    __atomLastLinkedInSig = sig;
    chrome.runtime.sendMessage(
      { type: "LINKEDIN_CONTEXT", payload: ctx },
      () => { void chrome.runtime.lastError; } // popup/SW may be asleep — fine
    );
  } catch (e) { /* silence: detection must never break the page */ }
}
__atomScanLinkedIn();
document.addEventListener("click", () => { setTimeout(__atomScanLinkedIn, 1500); }, true);
window.addEventListener("popstate", () => { setTimeout(__atomScanLinkedIn, 800); });

// Also add keypoints action

/* ================================================================
   KEYBOARD SHORTCUTS
   ================================================================ */

// Free-variable audit of panel/fab in this file: both are top-level consts
// (fab line ~231, panel line ~250) and every use below is inside a listener
// that cannot fire until this whole script has run top-to-bottom — if
// document.body were missing at the fab append, the script would abort there
// and attach no listeners at all, so there is no path where the bindings are
// undefined. The bindings CAN be detached from the document, though: panel is
// not mounted until injectUI() runs (first fab click or text selection), so
// the shortcuts below must call injectUI() before triggering panel children —
// otherwise their handlers dereference getElementById() nulls.

document.addEventListener("keydown", (e) => {
  // Ctrl+Shift+Space — toggle panel
  if (e.ctrlKey && e.shiftKey && e.code === "Space") {
    e.preventDefault();
    fab.click();
  }
  // Ctrl+Shift+S — summarize page instantly
  if (e.ctrlKey && e.shiftKey && e.code === "KeyS") {
    e.preventDefault();
    injectUI(); // panel may never have been mounted (no fab click yet)
    if (!panelOpen) { panelOpen = true; panel.classList.add("visible"); fab.innerHTML = `✕ <span class="atom-fab-label">Close</span>`; }
    panel.querySelector('[data-page="summarize"]').click();
  }
  // Ctrl+Shift+E — extract leads
  if (e.ctrlKey && e.shiftKey && e.code === "KeyE") {
    e.preventDefault();
    injectUI(); // same mount-first requirement as Ctrl+Shift+S
    if (!panelOpen) { panelOpen = true; panel.classList.add("visible"); fab.innerHTML = `✕ <span class="atom-fab-label">Close</span>`; }
    panel.querySelector('[data-page="leads"]').click();
  }
  // Escape — close panel and toolbar
  if (e.key === "Escape") {
    panelOpen = false;
    panel.classList.remove("visible");
    toolbar.classList.remove("visible");
    fab.innerHTML = `✦ <span class="atom-fab-label">Atom.AI</span>`;
  }
});



