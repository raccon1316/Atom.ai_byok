// notes.js
import { Utils } from './utils.js';

// Notes hold LLM output and page-derived text and are rendered with innerHTML,
// so everything interpolated below is escaped. Without this, a note containing
// markup executes script in the popup, which runs with extension privileges.
function esc(value) {
  return String(value == null ? '' : value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// Only http(s) links are ever emitted. A stored "javascript:" URL in an href
// would run in the popup's extension context on click.
function safeUrl(value) {
  const s = String(value == null ? '' : value).trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

// Notes are historically either {text, url, savedAt} objects or bare strings.
function noteText(note) {
  return String((note && note.text) || note || '');
}

export class Notes {
  constructor() {
    this.initEventListeners();
    this.load();
  }

  async load(filter = "") {
    const data = await chrome.storage.local.get(["notes"]);
    const allNotes = Array.isArray(data.notes) ? data.notes : [];
    const q = String(filter || "").trim().toLowerCase();

    // Each row carries its REAL position in the stored array. Rows used to be
    // stamped with their index in the FILTERED list, while the delete and copy
    // handlers read that index against the full list — so with a search filter
    // active, deleting the top visible note silently removed an unrelated one
    // (the oldest), with no confirmation and nothing to undo.
    const rows = allNotes
      .map((note, storageIndex) => ({ note, storageIndex }))
      .filter(({ note }) => !q || noteText(note).toLowerCase().includes(q))
      .reverse();

    const list = document.getElementById("notesList");
    const empty = document.getElementById("notesEmpty");
    if (!list) return;
    list.querySelectorAll(".note-card").forEach((el) => el.remove());
    if (empty) empty.style.display = rows.length ? "none" : "block";
    rows.forEach(({ note, storageIndex }) => {
      const card = document.createElement("div");
      card.className = "note-card";
      const href = safeUrl(note && note.url);
      const shortUrl = href.replace(/https?:\/\//, "").split("/")[0];
      card.innerHTML = `
        <div class="note-card-text" id="note-text-${storageIndex}">${esc(noteText(note).substring(0, 500))}</div>
        <div class="note-card-meta">
          <span class="note-card-date">${esc((note && note.savedAt) || "")}</span>
          ${shortUrl ? `<a class="note-card-url" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(href)}">${esc(shortUrl)}</a>` : ""}
          <div class="note-card-actions">
            <button class="note-card-btn" data-action="more" data-idx="${storageIndex}">More</button>
            <button class="note-card-btn" data-action="copy" data-idx="${storageIndex}">Copy</button>
            <button class="note-card-btn del" data-action="delete" data-idx="${storageIndex}">x</button>
          </div>
        </div>
      `;
      list.appendChild(card);
    });

    list.querySelectorAll("[data-action='more']").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx);
        const el = document.getElementById(`note-text-${idx}`);
        if (el) {
          el.classList.toggle("expanded");
          btn.innerText = el.classList.contains("expanded") ? "Less" : "More";
        }
      });
    });
    list.querySelectorAll("[data-action='copy']").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const idx = parseInt(btn.dataset.idx);
        const stored = await chrome.storage.local.get(["notes"]);
        const all = Array.isArray(stored.notes) ? stored.notes : [];
        const note = all[idx];
        if (note === undefined) return; // the list changed under us
        await navigator.clipboard.writeText(noteText(note));
        btn.innerText = "OK";
        setTimeout(() => btn.innerText = "Copy", 1000);
      });
    });
    list.querySelectorAll("[data-action='delete']").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const idx = parseInt(btn.dataset.idx);
        const stored = await chrome.storage.local.get(["notes"]);
        const notes = Array.isArray(stored.notes) ? stored.notes.slice() : [];
        if (!(idx >= 0 && idx < notes.length)) return; // stale row
        notes.splice(idx, 1);
        const save = await Utils.setBoundedStorageArray("notes", notes, {
          maxItems: 200,
          minItems: 25,
          trimStep: 10
        });
        if (!save.ok) await Utils.writeDebugLog(`Failed to save notes: ${save.error?.message || "quota error"}`, "warn");
        this.load(document.getElementById("notesSearch")?.value);
      });
    });
  }

  async export() {
    const data = await chrome.storage.local.get(["notes"]);
    const notes = data.notes || [];
    if (!notes.length) return alert("No notes to export.");
    const text = notes.map((n, i) => `NOTE ${i + 1} - ${n.savedAt || ""}\nSource: ${n.url || "unknown"}\n\n${n.text || n}`).join("\n\n" + "=".repeat(40) + "\n\n");
    const blob = new Blob([text], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "atom_notes.txt";
    a.click();
  }

  async clearAll() {
    if (confirm("Delete ALL saved notes? This cannot be undone.")) {
      await chrome.storage.local.remove("notes");
      this.load();
    }
  }

  initEventListeners() {
    const search = document.getElementById("notesSearch");
    if (search) search.addEventListener("input", (e) => this.load(e.target.value));
    const exportBtn = document.getElementById("notesExport");
    if (exportBtn) exportBtn.addEventListener("click", () => this.export());
    const clearBtn = document.getElementById("notesClearAll");
    if (clearBtn) clearBtn.addEventListener("click", () => this.clearAll());
  }
}
