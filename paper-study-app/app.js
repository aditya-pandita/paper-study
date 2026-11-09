/* Paper Study: imports study packs, gates visuals by stage, runs the four passes,
 * the debrief, the answer key and spaced card review. Everything stays on this
 * device (IndexedDB). No network calls.
 *
 * UX notes (Laws of UX) are tagged inline as [Law] where a choice follows one. */
(function () {
  "use strict";
  const V = window.PackValidator;
  // Inside the Mac or Android app, file picking, hashing and the clipboard go through the native bridge.
  const MAC = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.paperstudy;
  const ANDROID = window.PaperStudyAndroid;
  const NATIVE = MAC || ANDROID;
  const native = (msg) => MAC ? MAC.postMessage(msg) : ANDROID.postMessage(JSON.stringify(msg));
  // Android gets its own, phone-first experience (Material patterns); Mac and web keep the desktop layout.
  if (ANDROID) document.documentElement.classList.add("android");
  const haptic = (kind) => { if (ANDROID) native({ type: "haptic", kind }); };
  // Desktop (Mac and wide browsers) uses the extra width: sidebars and a reading pane.
  const isWide = () => !ANDROID && matchMedia("(min-width: 1100px)").matches;
  let lastWide = null, resizeT = null;
  window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (isWide() !== lastWide) route(); }, 200); });
  // [Jakob's Law] Android: app bar with a back arrow and the screen's title
  function setAppBar(title, back) {
    const t = document.getElementById("appbar-title"), b = document.getElementById("appbar-back");
    if (!t || !b) return;
    t.textContent = title || ""; b.hidden = !back; b.onclick = () => { location.hash = back; };
    document.documentElement.classList.toggle("in-sub", !!back);
  }
  // swipe left/right on touch screens; ignores mostly-vertical moves (scrolling)
  function onSwipe(node, left, right) {
    let x0 = null, y0 = null;
    node.addEventListener("touchstart", (e) => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; }, { passive: true });
    node.addEventListener("touchend", (e) => {
      if (x0 === null) return; const t = e.changedTouches[0]; const dx = t.clientX - x0, dy = t.clientY - y0; x0 = null;
      if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
      if (dx < 0 && left) left(); if (dx > 0 && right) right();
    }, { passive: true });
  }

  // ---------- stages ----------
  // [Mental Model] each pass is named for what you do in it, not only its number.
  // [Parkinson's Law] each stage carries a suggested time box (our suggestion, not the paper's).
  const STAGES = [
    { key: "pass1", label: "Skim", title: "Pass 1 · Skim", box: "10 min", help: "" },
    { key: "triage_done", label: "Triage", title: "Triage", box: "2 min", help: "" },
    { key: "pass2", label: "Outline", title: "Pass 2 · Outline", box: "30 min", help: "" },
    { key: "pass3", label: "Read", title: "Pass 3 · Read it through", box: "60 min", help: "" },
    { key: "pass4", label: "Master", title: "Pass 4 · Master it", box: "90 min", help: "" },
    { key: "debrief", label: "Debrief", title: "Debrief: Ng's four questions", box: "10 min", help: "" },
    { key: "deep", label: "Beyond", title: "Beyond the paper", box: null, help: "" },
  ];
  // stage index at which each unlock value becomes visible; debrief material waits until the debrief is submitted
  const UNLOCK_AT = { pass1: 0, triage_done: 1, pass2: 2, pass3: 3, pass4: 4, debrief: 6, deep: 6 };
  const INTERVALS = [1, 3, 7, 14, 30, 60]; // days, Leitner boxes 1..6

  // ---------- tiny DOM helper (never uses innerHTML with pack data) ----------
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid instanceof Node ? kid : String(kid));
    return n;
  }
  const main = document.getElementById("main");
  const modal = document.getElementById("modal");
  const modalBody = document.getElementById("modal-body");
  function showModal(...content) { modalBody.replaceChildren(...content); if (!modal.open) modal.showModal(); }
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.close(); }); // tap the scrim to dismiss
  const plural = (n, word, many) => `${n} ${n === 1 ? word : (many || word + "s")}`;
  function progressBar(value, max, label) {
    return el("div", { class: "progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(max), "aria-valuenow": String(value), "aria-label": label },
      el("span", { style: `width:${max ? Math.round((100 * value) / max) : 0}%` }));
  }
  // [Doherty Threshold] small, instant confirmation instead of waiting on anything
  let toastTimer = null;
  function toast(text) {
    let t = document.getElementById("toast");
    if (!t) { t = el("div", { id: "toast", role: "status", "aria-live": "polite" }); document.body.append(t); }
    t.textContent = text; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
  }

  // ---------- storage ----------
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open("paper-study", 2);
      r.onupgradeneeded = () => {
        for (const s of ["packs", "progress", "profile"]) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: "id" });
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode); const s = t.objectStore(store);
      const r = fn(s); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error);
    });
  }
  const getAll = (s) => tx(s, "readonly", (st) => st.getAll());
  const get = (s, id) => tx(s, "readonly", (st) => st.get(id));
  const put = (s, v) => tx(s, "readwrite", (st) => st.put(v));
  const del = (s, id) => tx(s, "readwrite", (st) => st.delete(id));

  function newProgress(id) { return { id, stage: 0, stopped: false, answers: {}, debrief: {}, cards: {}, hints: {}, ticks: {}, confusions: [], deep: {} }; }
  async function saveProgress(p) { p.updated = Date.now(); await put("progress", p); }

  // ---------- game: XP, levels, streaks, badges ----------
  // [Goal-Gradient] [Peak-End] [Zeigarnik] small rewards for every real step of Ng's method.
  const LEVELS = [[0, "Skimmer"], [100, "Reader"], [250, "Explorer"], [500, "Analyst"], [900, "Critic"], [1400, "Scholar"],
    [2000, "Researcher"], [2800, "Expert"], [3800, "Master"], [5000, "Legend"]];
  const WEEKLY_GOAL = 3; // Ng: read about 2-3 papers a week, steadily
  const BADGES = [
    ["first-steps", "First steps", "Earn your first XP"],
    ["skimmer", "Skimmer", "Finish Pass 1 on any paper"],
    ["decider", "Decider", "Make a triage call"],
    ["deep-diver", "Deep diver", "Finish Pass 4, maths and all"],
    ["four-questions", "Four questions", "Answer Ng's debrief questions"],
    ["boss", "Boss beater", "Win a boss quiz"],
    ["flawless", "Flawless", "Win a boss quiz with every card right"],
    ["deriver", "Derivation hero", "Re-derive a result without a hint"],
    ["honest", "Honest reader", "Note something that didn't make sense"],
    ["explorer", "Explorer", "Jump to a cited paper's pack"],
    ["fact-checker", "Fact-checker", "Finish the trust check on a pack"],
    ["curator", "Curator", "Put a paper on your reading list"],
    ["streak-3", "On a roll", "Study 3 days in a row"],
    ["streak-7", "Habit formed", "Study 7 days in a row"],
    ["weekly", "Ng's pace", `Study ${WEEKLY_GOAL} different papers in one week`],
  ];
  const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const weekKey = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dayKey(d); };
  async function getProfile() {
    return (await get("profile", "me")) || { id: "me", xp: 0, awarded: {}, log: [], days: {}, weeks: {}, badges: {}, readingList: [] };
  }
  function levelInfo(xp) {
    let i = 0; while (i + 1 < LEVELS.length && xp >= LEVELS[i + 1][0]) i++;
    const [base, name] = LEVELS[i]; const next = LEVELS[i + 1];
    return { level: i + 1, name, base, next: next ? next[0] : null, into: xp - base, span: next ? next[0] - base : 1 };
  }
  function streak(profile) {
    let n = 0; const d = new Date(); d.setHours(0, 0, 0, 0);
    if (!profile.days[dayKey(d)]) d.setDate(d.getDate() - 1); // today not studied yet: count up to yesterday
    while (profile.days[dayKey(d)]) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  const papersThisWeek = (profile) => Object.keys(profile.weeks[weekKey(Date.now())] || {}).length;
  // award XP once per key; returns the XP actually given
  async function award(key, xp, why, paperId, extraBadges) {
    const p = await getProfile();
    if (p.awarded[key]) { if (extraBadges) await grantBadges(p, extraBadges); return 0; }
    const before = levelInfo(p.xp).level;
    p.awarded[key] = Date.now(); p.xp += xp;
    p.log.unshift({ t: Date.now(), xp, why }); p.log = p.log.slice(0, 60);
    p.days[dayKey(Date.now())] = true;
    if (paperId) { const w = weekKey(Date.now()); (p.weeks[w] = p.weeks[w] || {})[paperId] = true; }
    const earned = ["first-steps", ...(extraBadges || [])];
    if (streak(p) >= 3) earned.push("streak-3");
    if (streak(p) >= 7) earned.push("streak-7");
    if (papersThisWeek(p) >= WEEKLY_GOAL) earned.push("weekly");
    await grantBadges(p, earned, true);
    await put("profile", p);
    const after = levelInfo(p.xp);
    toast(`+${xp} XP · ${why}`);
    if (after.level > before) setTimeout(() => celebrate(`Level ${after.level}: ${after.name}`), 400);
    renderHud(p);
    return xp;
  }
  async function grantBadges(p, ids, noSave) {
    const fresh = ids.filter((b) => !p.badges[b] && BADGES.some(([id]) => id === b));
    for (const b of fresh) p.badges[b] = Date.now();
    if (!noSave && fresh.length) await put("profile", p);
    fresh.forEach((b, i) => setTimeout(() => celebrate("Badge: " + BADGES.find(([id]) => id === b)[1]), 900 + i * 1200));
  }
  // [Peak-End Rule] a short burst of confetti at the moments that matter
  function celebrate(text) {
    const layer = el("div", { class: "celebrate", "aria-live": "polite" }, el("div", { class: "celebrate-card" }, text));
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const colors = ["#0F6E56", "#854F0B", "#185FA5", "#993C1D", "#E8B56A"];
      for (let i = 0; i < 46; i++) layer.append(el("i", { style: `left:${Math.random() * 100}%;background:${colors[i % 5]};animation-delay:${Math.random() * 0.25}s;transform:rotate(${Math.random() * 360}deg)` }));
    }
    document.body.append(layer); setTimeout(() => layer.remove(), 2200); haptic("confirm");
  }
  async function renderHud(p) {
    p = p || await getProfile();
    const hud = document.getElementById("hud"); if (!hud) return;
    const li = levelInfo(p.xp); const s = streak(p);
    hud.replaceChildren(
      el("span", { class: "hud-level" }, `Lv ${li.level}`),
      el("span", { class: "hud-xp" }, el("span", { class: "hud-bar" }, el("span", { style: `width:${Math.round((100 * li.into) / li.span)}%` })), el("span", { class: "hud-num" }, `${p.xp} XP`)),
      el("span", { class: "hud-streak", title: "Days in a row" }, `🔥 ${s}`));
    hud.setAttribute("aria-label", `Level ${li.level} ${li.name}, ${p.xp} XP, ${s}-day streak. Open your profile.`);
  }

  // ---------- helpers ----------
  async function sha256Hex(buf) {
    const h = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function textId(s) {
    if (window.crypto && crypto.subtle) return (await sha256Hex(new TextEncoder().encode(s))).slice(0, 12);
    let h = 0xcbf29ce484222325n; // FNV-1a 64 fallback where WebCrypto is unavailable
    for (const b of new TextEncoder().encode(s)) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
    return h.toString(16).padStart(16, "0").slice(0, 12);
  }
  function copyText(text) { return NATIVE ? (native({ type: "copy", text }), Promise.resolve()) : navigator.clipboard.writeText(text); }
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const DAY = 86400000;
  const loc = (l) => l ? `p. ${l.page}${l.ref ? ", " + l.ref : ""}${l.printed_page ? " (printed " + l.printed_page + ")" : ""}` : "";
  const unlocked = (v, stage) => (UNLOCK_AT[v.unlock] ?? 99) <= stage;
  const visualsOf = (pack) => ((pack.files["visuals.json"] || {}).visuals || []);
  const cardsOf = (pack) => ((pack.files["cards.json"] || {}).cards || []);
  const questionsFor = (pack, key) => ((pack.files["questions.json"] || {})[key] || []);
  function dueCards(pack, prog) {
    if (prog.stage < 1) return [];
    return cardsOf(pack).filter((c) => ((prog.cards[c.id] || {}).due || 0) <= Date.now());
  }
  const parseJson = (text) => JSON.parse(String(text).replace(/^﻿/, "")); // [Postel's Law] tolerate a BOM

  // ---------- import ----------
  const MIME = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", html: "text/html", mp4: "video/mp4" };

  // [Postel's Law] accept the pack folder itself, or a parent folder that holds exactly one pack.
  function packPrefix(paths) {
    const manifests = paths.filter((p) => p === "manifest.json" || p.endsWith("/manifest.json")).sort((a, b) => a.length - b.length);
    return manifests.length ? manifests[0].slice(0, -"manifest.json".length) : "";
  }
  async function fromFileList(list) {
    const entries = [...list].filter((f) => !f.name.startsWith(".")).map((f) => ({ f, rel: (f.webkitRelativePath || f.name).split("/").slice(f.webkitRelativePath ? 1 : 0).join("/") }));
    // a lone .pack.json bundle
    for (const { f } of entries) if (f.name.endsWith(".json") && entries.length === 1) {
      try { const obj = parseJson(await f.text()); if (obj && obj.pack_format === "study-pack-bundle/1") return fromBundle(obj); } catch (e) { /* reported below */ }
    }
    const raw = { files: {}, assets: {} };
    for (const { f, rel } of entries) {
      const ext = rel.split(".").pop().toLowerCase();
      if (ext === "json") raw.files[rel] = await f.text();
      else if (MIME[ext]) {
        const a = { mime: MIME[ext] };
        if (ext === "svg" || ext === "html") a.text = await f.text();
        else a.blob = new Blob([await f.arrayBuffer()], { type: MIME[ext] });
        raw.assets[rel] = a;
      }
    }
    return fromRaw(raw);
  }
  function fromBundle(obj) {
    const pack = { files: obj.files || {}, assets: {}, parseErrors: [], blobs: {} };
    for (const [path, a] of Object.entries(obj.assets || {})) {
      pack.assets[path] = { mime: a.mime, text: a.text };
      if (a.blob) { pack.blobs[path] = a.blob; continue; }
      const bytes = a.base64 ? Uint8Array.from(atob(a.base64), (c) => c.charCodeAt(0)) : new TextEncoder().encode(a.text || "");
      pack.blobs[path] = new Blob([bytes], { type: a.mime });
    }
    return pack;
  }
  // Payload from the native apps (and the browser path above):
  // { files: { "<rel>.json": "<text>" }, assets: { "<rel>": { mime, text? | base64? | blob? } } }
  function fromRaw(payload) {
    const files = payload.files || {}; const assets = payload.assets || {};
    const prefix = packPrefix(Object.keys(files));
    const strip = (p) => p.startsWith(prefix) ? p.slice(prefix.length) : null;
    const pack = { files: {}, assets: {}, parseErrors: [], blobs: {} };
    for (const [path, text] of Object.entries(files)) {
      const name = strip(path);
      let obj;
      try { obj = parseJson(text); } catch (e) {
        if (name && V.DATA_FILES.includes(name)) pack.parseErrors.push({ level: "error", file: name, id: null, message: "invalid JSON: " + e.message });
        continue;
      }
      if (obj && obj.pack_format === "study-pack-bundle/1") return fromBundle(obj);
      if (name && V.DATA_FILES.includes(name)) pack.files[name] = obj;
    }
    const moved = {};
    for (const [path, a] of Object.entries(assets)) { const name = strip(path); if (name && (name.startsWith("visuals/") || name.endsWith(".html"))) moved[name] = a; }
    const b = fromBundle({ files: {}, assets: moved });
    Object.assign(pack.assets, b.assets); Object.assign(pack.blobs, b.blobs);
    return pack;
  }

  async function handleImport(list) {
    if (!list || !list.length) return;
    showModal(el("p", {}, "Reading the pack…")); // [Doherty Threshold] respond at once
    await showImportReport(await fromFileList(list));
  }

  // [Cognitive Load] [Chunking] group warnings by kind and fold the detail away; errors come first.
  function summariseIssues(issues) {
    const groups = new Map();
    for (const i of issues) {
      const kind = i.level === "error" ? "Errors to fix" : /not found \(planned/.test(i.message) ? "Pictures not drawn yet (visuals and card images)" : "Other warnings";
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind).push(i);
    }
    return groups;
  }
  function issueGroups(issues) {
    return [...summariseIssues(issues)].map(([kind, list]) => el("details", { class: "issue-group", open: kind === "Errors to fix" ? true : null },
      el("summary", {}, `${kind} (${list.length})`), el("div", { class: "issues" }, V.formatIssues(list, "").replace(/^\n/, ""))));
  }

  async function showImportReport(pack) {
    const issues = [...pack.parseErrors, ...V.validate(pack)];
    const errors = issues.filter((i) => i.level === "error");
    const m = pack.files["manifest.json"];
    const report = V.formatIssues(issues, `Study pack issues${m ? " for " + m.title : ""}:`);
    const copyBtn = el("button", { class: errors.length ? "btn" : "btn secondary", onclick: () => copyText(report).then(() => toast("Issues list copied")) }, "Copy issues list");
    if (errors.length) {
      showModal(el("h2", {}, "This pack can't be added yet"),
        el("p", {}, `${plural(errors.length, "error")} need fixing. Copy the list and paste it into the chat that made the pack; it will send back corrected files.`),
        ...issueGroups(issues), el("div", { class: "row actions" }, copyBtn));
      return;
    }
    const drawnLater = issues.filter((i) => i.file === "visuals.json" && /not found \(planned/.test(i.message)).length;
    showModal(
      el("h2", {}, m ? m.title : "Pack checked"),
      el("p", {}, "The pack is valid and ready to study.", drawnLater ? ` ${plural(drawnLater, "visual")} are planned but not drawn yet; they'll show as placeholders.` : ""),
      ...(issues.length ? issueGroups(issues) : []),
      el("div", { class: "row actions" },
        el("button", { class: "btn", autofocus: true, onclick: async () => { modal.close(); const id = await savePack(pack, issues); toast("Added to your library"); location.hash = "#/pack/" + id; } }, "Add and start"),
        issues.length ? copyBtn : null));
  }

  async function savePack(pack, issues) {
    const m = pack.files["manifest.json"];
    const id = m.paper_id || "p-" + (m.pdf_sha256 ? m.pdf_sha256.slice(0, 12) : await textId(m.source + "|" + m.title));
    m.paper_id = id;
    const existing = await get("packs", id);
    await put("packs", { id, files: pack.files, blobs: pack.blobs, warnings: issues.filter((i) => i.level === "warning"), imported: Date.now(), pdfHash: existing && existing.pdfHash });
    if (!(await get("progress", id))) await saveProgress(newProgress(id));
    return id;
  }

  // [Hick's Law] one Import entry point; the two kinds live inside it.
  const pickFolder = () => NATIVE ? native({ type: "import-folder" }) : document.getElementById("pick-folder").click();
  const pickFile = () => NATIVE ? native({ type: "import-file" }) : document.getElementById("pick-files").click();
  document.getElementById("pick-folder").addEventListener("change", (e) => { handleImport(e.target.files); e.target.value = ""; });
  document.getElementById("pick-files").addEventListener("change", (e) => { handleImport(e.target.files); e.target.value = ""; });
  document.getElementById("import-folder").addEventListener("click", (e) => { e.target.closest("details").open = false; pickFolder(); });
  document.getElementById("import-file").addEventListener("click", (e) => { e.target.closest("details").open = false; pickFile(); });
  if (NATIVE) document.documentElement.classList.add("native");
  // Called by the Mac and Android apps.
  window.PaperStudy = {
    importRaw: (payload) => showImportReport(fromRaw(payload)),
    goHome: () => { location.hash = "#/"; },
    // Android system Back: close what's on top before leaving the screen
    onBack: () => {
      if (modal.open) { modal.close(); return true; }
      const menu = document.querySelector("details.menu[open]"); if (menu) { menu.open = false; return true; }
      return false;
    },
  };

  // ---------- visuals ----------
  const urlCache = new Map();
  function blobUrl(pack, path) {
    const key = pack.id + "|" + path;
    if (!urlCache.has(key) && pack.blobs[path]) urlCache.set(key, URL.createObjectURL(pack.blobs[path]));
    return urlCache.get(key);
  }
  // [Law of Common Region] image, title, purpose and source sit inside one bordered card.
  function visualFigure(pack, v) {
    const src = blobUrl(pack, v.file);
    const notes = [];
    if (v.redrawn_from) notes.push(`Redrawn and simplified from ${v.redrawn_from}, ${loc(v.source)}.`);
    else if (v.type !== "original_figure") notes.push(`Source: ${loc(v.source)}.`);
    if (v.credit) notes.push(v.credit);
    const badges = [v.analogy ? el("span", { class: "badge analogy" }, "Analogy, not from the paper") : null,
      v.type === "original_figure" ? el("span", { class: "badge" }, "Original figure") : null];
    let media;
    if (!src) media = el("div", { class: "missing" }, "Not drawn yet");
    else if (v.type === "explainer") media = el("iframe", { class: "explainer", src, sandbox: "allow-scripts", title: v.alt_text });
    else if (v.type === "video") media = el("video", { class: "packvideo", src, controls: true, preload: "metadata", playsinline: true, "aria-label": v.alt_text });
    else media = el("button", { class: "frame" + (v.file.endsWith(".svg") ? "" : " raster"), "aria-label": "Enlarge: " + v.title,
      onclick: () => showModal(el("h3", {}, v.title), el("img", { src, alt: v.alt_text }), el("p", { class: "small muted" }, notes.join(" "))) },
      el("img", { src, alt: v.alt_text, loading: "lazy" }));
    return el("figure", { class: "visual" }, media,
      el("figcaption", {}, el("div", { class: "row tight" }, el("strong", {}, v.title), ...badges),
        v.purpose ? el("div", { class: "muted" }, v.purpose) : null,
        el("div", { class: "small muted" }, notes.join(" "))));
  }

  // ---------- library ----------
  // [Zeigarnik Effect] every paper says what is unfinished and what comes next.
  function nextStep(pack, prog) {
    const st = STAGES[prog.stage];
    if (prog.stage === 0 || (prog.stage >= 2 && prog.stage <= 4)) {
      const qs = questionsFor(pack, st.key); const done = qs.filter((q) => (prog.answers[q.id] || "").trim()).length;
      return `${st.title}: ${done} of ${qs.length} answered`;
    }
    if (prog.stage === 1) return prog.stopped ? "Stopped at triage. Cards still in review." : "Triage: decide whether to go on";
    if (prog.stage === 5) return "Debrief: four questions left";
    return "Finished the passes. Answer key unlocked.";
  }

  async function renderLibrary() {
    setAppBar("", null);
    const packs = await getAll("packs");
    const progress = Object.fromEntries((await getAll("progress")).map((p) => [p.id, p]));
    const prof = await getProfile();
    if (!packs.length) {
      // [Paradox of the Active User] no manual: three steps and one button.
      main.replaceChildren(el("section", { class: "panel empty" },
        el("h1", {}, "Read papers like Andrew Ng"),
        el("ol", { class: "steps" },
          el("li", {}, el("strong", {}, "Import"), " a study pack made by the pack generator prompt."),
          el("li", {}, el("strong", {}, "Go through four passes"), ": skim, outline, read, master. Each one tells you exactly what to read."),
          el("li", {}, el("strong", {}, "Level up"), ": XP, badges and a streak toward 2-3 papers a week.")),
        el("button", { class: "btn big", onclick: pickFolder }, "Import a pack folder"),
        el("p", { class: "small muted" }, "Have a single .pack.json? ", el("button", { class: "link", onclick: pickFile }, "Import that instead"), ".")));
      return;
    }
    const totalDue = packs.reduce((n, p) => n + dueCards(p, progress[p.id] || newProgress(p.id)).length, 0);
    const week = papersThisWeek(prof); const li = levelInfo(prof.xp);
    const idx = libraryIndex(packs);
    // [Goal-Gradient] [Zeigarnik] this week's target, Ng's 2-3 papers
    const goal = el("section", { class: "panel goal" },
      el("div", { class: "row spread" }, el("div", {}, el("strong", {}, `Level ${li.level} · ${li.name}`), el("div", { class: "small muted" }, li.next ? `${li.next - prof.xp} XP to level ${li.level + 1}` : "Top level")),
        el("a", { class: "btn ghost", href: "#/me" }, "Profile & badges")),
      el("div", { class: "goalrow" },
        el("div", {}, el("div", { class: "big-num" }, `${week}/${WEEKLY_GOAL}`), el("div", { class: "small muted" }, "papers this week")),
        el("div", {}, el("div", { class: "big-num" }, `🔥 ${streak(prof)}`), el("div", { class: "small muted" }, "day streak")),
        el("div", {}, el("div", { class: "big-num" }, String(totalDue)), el("div", { class: "small muted" }, "cards due"))),
      progressBar(Math.min(week, WEEKLY_GOAL), WEEKLY_GOAL, "Weekly goal"));
    const cardsEls = packs.sort((a, b) => ((progress[b.id] || {}).updated || b.imported) - ((progress[a.id] || {}).updated || a.imported)).map((pack) => {
      const m = pack.files["manifest.json"]; const p = progress[pack.id] || newProgress(pack.id);
      const due = dueCards(pack, p).length; const rp = readingProgress(pack, p);
      const st = STAGES[p.stage];
      // [Von Restorff] one filled primary action per paper; [Hick's Law] the rest sit under "More".
      const primary = el("a", { class: "btn", href: `#/pack/${pack.id}/journey` }, p.stage === 0 && !Object.keys(p.ticks || {}).length ? "Start Pass 1" : `Continue: ${st.label}`);
      return el("section", { class: "panel libcard" },
        el("h2", {}, el("a", { href: "#/pack/" + pack.id }, m.title)),
        el("div", { class: "muted small" }, (m.authors || []).slice(0, 3).join(", ") + ((m.authors || []).length > 3 ? " et al." : ""), " · ", m.source),
        // [Goal-Gradient Effect] the quest so far
        el("div", { class: "libprogress" }, progressBar(p.stage, STAGES.length - 1, "Quest progress"), el("span", { class: "small" }, nextStep(pack, p))),
        rp.total ? el("div", { class: "small muted libpractice" }, `Summary: ${rp.read} of ${rp.total} steps read`) : null,
        trustBadge(pack, p),
        el("div", { class: "row" }, primary,
          due && p.stage >= 1 ? el("a", { class: "btn secondary", href: `#/pack/${pack.id}/cards` }, `Review ${plural(due, "card")}`) : null,
          rp.total ? el("a", { class: "btn secondary", href: `#/pack/${pack.id}/read` }, "Summary") : null,
          el("details", { class: "menu" }, el("summary", { class: "btn ghost", "aria-label": "More actions" }, "More"),
            el("div", { class: "menu-list" },
              el("button", { onclick: () => applyFixesUI(pack) }, "Apply fixes from chat…"),
              el("button", { onclick: () => { location.hash = `#/pack/${pack.id}/reference/check`; } }, "Check the pack (trust list)…"),
              pack.warnings && pack.warnings.length ? el("button", { onclick: () => showModal(el("h2", {}, "Pack warnings"), ...issueGroups(pack.warnings)) }, `Show ${plural(pack.warnings.length, "warning")}`) : null,
              el("button", { class: "danger", onclick: async () => {
                if (!confirm(`Remove "${m.title}" and all your answers and card history for it? This cannot be undone.`)) return;
                await del("packs", pack.id); await del("progress", pack.id); toast("Removed"); renderLibrary();
              } }, "Remove from this device…")))),
        null);
    });
    // Ng's step zero: a reading list. Papers you flagged, marked when their pack arrives.
    const rl = prof.readingList || [];
    const listPanel = rl.length ? el("section", { class: "panel" }, el("h2", {}, `Reading list (${rl.length})`),
      el("p", { class: "small muted" }, "Make a pack for one of these with the generator prompt, then import it: citations between your papers link up automatically."),
      el("ul", { class: "plain refs" }, rl.map((r) => {
        const have = idx.match(r);
        return el("li", { class: "row spread" }, el("div", {}, el("strong", {}, r.title), r.year ? ` (${r.year})` : "",
          el("div", { class: "small muted" }, "From " + (r.fromTitle || "a paper"), r.link ? [" · ", el("a", { href: r.link, target: "_blank", rel: "noopener noreferrer" }, "link")] : null)),
          el("div", { class: "row tight" }, have ? el("button", { class: "btn small-btn", onclick: () => openLinked(have) }, "Open its pack →") : null,
            el("button", { class: "btn ghost small-btn", "aria-label": "Remove from reading list", onclick: async () => {
              const p = await getProfile(); p.readingList = p.readingList.filter((x) => x.key !== r.key); await put("profile", p); renderLibrary();
            } }, "✕")));
      }))) : null;
    lastWide = isWide();
    main.replaceChildren(el("h1", {}, "Your papers"),
      el("div", { class: "lib-layout" }, el("div", { class: "lib-papers" }, ...cardsEls), el("aside", { class: "lib-side" }, goal, listPanel || el("span"))));
  }

  // ---------- paper view ----------
  // [Hick's Law] [Serial Position Effect] five tabs at most, only unlocked ones shown; Read first (the main job), Cards last.
  // The answer key lives under Practice, so it needs no tab of its own.
  const lessonsOf = (pack) => ((pack.files["lessons.json"] || {}).lessons || []);
  function tabsFor(pack, prog) {
    const due = dueCards(pack, prog).length;
    return [
      ["journey", "Journey", true],
      ["read", "Summary", lessonsOf(pack).length > 0],
      ["visuals", "Visuals", true],
      ["reference", "Reference", true],
      ["cards", due ? `Cards · ${due}` : "Cards", prog.stage >= 1],
    ].filter(([, , ok]) => ok);
  }

  // Material-style outline icons for the Android bottom navigation
  const ICONS = {
    journey: "M5 21V4h9l1 2h5v9h-7l-1-2H7v8z",
    read: "M4 5c3-1 6-1 8 1 2-2 5-2 8-1v14c-3-1-6-1-8 1-2-2-5-2-8-1zM12 6v14",
    visuals: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5a1.5 1.5 0 1 0 0.01 0",
    reference: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
    cards: "M7 4h11a1 1 0 0 1 1 1v13M4 7h11a1 1 0 0 1 1 1v12H5a1 1 0 0 1-1-1z",
  };
  function navIcon(k) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "tab-ico"); svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path"); path.setAttribute("d", ICONS[k] || ICONS.reference);
    path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "1.8"); path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
    svg.append(path); return el("span", { class: "tab-ico-wrap" }, svg);
  }

  // ---------- links between papers in your library ----------
  const normTitle = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const arxivId = (s) => { const m = String(s || "").match(/(\d{4}\.\d{4,5})/); return m ? m[1] : null; };
  function libraryIndex(packs) {
    const byArxiv = {}, byTitle = {};
    for (const p of packs) {
      const m = p.files["manifest.json"]; const a = arxivId(m.source);
      if (a) byArxiv[a] = p; byTitle[normTitle(m.title)] = p;
    }
    return { byArxiv, byTitle, match: (r) => (arxivId(r.link) && byArxiv[arxivId(r.link)]) || byTitle[normTitle(r.title)] || null };
  }
  async function crossLinks(pack) {
    const packs = await getAll("packs"); const idx = libraryIndex(packs);
    const cites = ((pack.files["refs.json"] || {}).refs || []).map((r) => idx.match(r)).filter((p) => p && p.id !== pack.id);
    const me = libraryIndex([pack]);
    const citedBy = packs.filter((p) => p.id !== pack.id && ((p.files["refs.json"] || {}).refs || []).some((r) => me.match(r)));
    return { cites: [...new Map(cites.map((p) => [p.id, p])).values()], citedBy };
  }
  const openLinked = (target) => { award(`explore:${target.id}`, 10, "Followed a citation", target.id, ["explorer"]); location.hash = "#/pack/" + target.id; };
  function refList(pack, refs) {
    const ul = el("ul", { class: "plain refs" });
    (async () => {
      const idx = libraryIndex(await getAll("packs")); const prof = await getProfile();
      const listed = new Set(prof.readingList.map((x) => x.key));
      ul.replaceChildren(...refs.map((r) => {
        const target = idx.match(r); const key = arxivId(r.link) || normTitle(r.title);
        const action = target && target.id !== pack.id
          ? el("button", { class: "btn small-btn", onclick: () => openLinked(target) }, "Open its pack →")
          : listed.has(key) ? el("span", { class: "badge high" }, "On your reading list ✓")
            : el("button", { class: "btn secondary small-btn", onclick: async (e) => {
              const p = await getProfile();
              if (!p.readingList.some((x) => x.key === key)) p.readingList.push({ key, title: r.title, year: r.year, link: r.link, from: pack.id, fromTitle: pack.files["manifest.json"].title, at: Date.now() });
              await put("profile", p); e.target.replaceWith(el("span", { class: "badge high" }, "On your reading list ✓"));
              award(`list:${key}`, 5, "Added to reading list", null, ["curator"]);
            } }, "+ Reading list");
        return el("li", {},
          el("div", { class: "row spread" }, el("div", {}, el("strong", {}, r.label + " "),
            r.link ? el("a", { href: r.link, target: "_blank", rel: "noopener noreferrer" }, r.title) : r.title, r.year ? ` (${r.year})` : ""), action),
          el("div", { class: "small muted" }, r.role.replace("_", " "), r.why_it_matters ? " · " + r.why_it_matters.text + " (" + loc(r.why_it_matters.where) + ")" : "",
            r.link && !r.link_verified ? el("span", { class: "badge warn" }, "link unverified") : null));
      }));
    })();
    return ul;
  }
  function readingProgress(pack, prog) {
    const steps = lessonsOf(pack).flatMap((l) => l.steps.map((s, i) => ({ lesson: l, step: s, n: i + 1 })));
    const read = steps.filter((x) => (prog.read || {})[x.step.id]).length;
    const next = steps.find((x) => !(prog.read || {})[x.step.id]);
    return { steps, read, total: steps.length, next };
  }

  let cleanup = []; // listeners from the previous screen
  async function renderPack(id, tab, sub, sub2) {
    cleanup.forEach((f) => f()); cleanup = [];
    const pack = await get("packs", id);
    if (!pack) { location.hash = "#/"; return; }
    const prog = (await get("progress", id)) || newProgress(id);
    const m = pack.files["manifest.json"];
    const tabs = tabsFor(pack, prog);
    if (!tab || tab === "study") tab = "journey";
    if (tab === "answers" && prog.stage < 6) tab = "journey";
    if (tab !== "answers" && !tabs.some(([k]) => k === tab)) tab = tabs[0][0];
    const selected = tab === "answers" ? "journey" : tab;
    const tabBar = el("nav", { class: "tabs", role: "tablist", "aria-label": "Sections" }, tabs.map(([k, label]) =>
      el("a", { class: "tab", role: "tab", href: `#/pack/${id}/${k}`, "aria-selected": String(k === selected) }, navIcon(k), el("span", { class: "tab-label" }, label))));
    // [Law of Uniform Connectedness] the quest track: one connected path of levels, locked ahead
    const stepper = el("ol", { class: "stepper quest", "aria-label": "Quest progress" }, STAGES.map((s, i) =>
      el("li", { class: i < prog.stage ? "done" : i === prog.stage ? "now" : "locked", "aria-current": i === prog.stage ? "step" : null },
        el("span", { class: "dot" }, i < prog.stage ? "✓" : i === prog.stage ? String(i + 1) : "🔒"), el("span", { class: "lbl" }, s.label))));
    const views = { read: viewRead, journey: viewStudy, visuals: viewVisuals, cards: viewCards, reference: viewReference, answers: viewAnswers };
    const body = await views[tab](pack, prog, sub, sub2);
    const links = await crossLinks(pack);
    const linkRow = links.cites.length || links.citedBy.length ? el("div", { class: "crosslinks small" },
      links.cites.length ? el("span", {}, "Cites in your library: ", ...links.cites.map((p) => el("button", { class: "chip", onclick: () => openLinked(p) }, p.files["manifest.json"].title))) : null,
      links.citedBy.length ? el("span", {}, "Cited by in your library: ", ...links.citedBy.map((p) => el("button", { class: "chip", onclick: () => openLinked(p) }, p.files["manifest.json"].title))) : null) : null;
    // [Cognitive Load] the quest track only shows where it matters: on the Journey tab
    lastWide = isWide();
    main.replaceChildren(...[
      el("a", { class: "back small", href: "#/" }, "← Library"),
      el("h1", { class: "paper-title" }, m.title), linkRow,
      el("div", { class: "pack-layout" + (selected === "journey" ? " with-quest" : "") },
        el("aside", { class: "pack-side" }, ...[selected === "journey" ? stepper : null, tabBar].filter(Boolean)),
        el("div", { class: "pack-main" }, body))].filter(Boolean));
    document.title = m.title + " · Paper Study";
    setAppBar(m.title, "#/");
    main.focus({ preventScroll: true });
  }
  const rerender = (pack, tab) => { const p = (tab || "journey").split("/"); return renderPack(pack.id, p[0], p[1], p[2]); };

  // [Doherty Threshold] answers save as you type, with a quiet "Saved" note.
  function questionBlock(prog, q, n, total, store, onChange) {
    const ta = el("textarea", { "aria-label": q.text, placeholder: q.type === "predict" ? "Your prediction…" : "Your answer…" });
    const saved = el("span", { class: "saved small muted", "aria-live": "polite" });
    ta.value = (store === "debrief" ? prog.debrief[q.key] : prog.answers[q.id]) || "";
    let t = null;
    ta.addEventListener("input", () => {
      if (store === "debrief") prog.debrief[q.key] = ta.value; else prog.answers[q.id] = ta.value;
      clearTimeout(t); t = setTimeout(async () => {
        await saveProgress(prog); saved.textContent = "Saved";
        if (ta.value.trim().length >= 12) award(`${prog.id}:ans:${q.id || q.key}`, 20, "Answered a question", prog.id);
      }, 700);
      saved.textContent = "";
      onChange();
    });
    // [Law of Proximity] number, type, question and box stay together
    return el("div", { class: "question" },
      el("div", { class: "qhead" }, el("span", { class: "qnum" }, `${n} of ${total}`), q.type ? el("span", { class: "qtype" }, q.type) : null),
      el("p", { class: "qtext" }, q.text), ta, saved);
  }

  async function advance(pack, prog, to, unlockedNote) {
    prog.stage = to; await saveProgress(prog);
    await rerender(pack, "journey");
    window.scrollTo(0, 0);
    if (unlockedNote) toast(unlockedNote);
  }
  function unlockSummary(pack, from, to) {
    const nv = visualsOf(pack).filter((v) => v.type !== "card_visual" && UNLOCK_AT[v.unlock] > from && UNLOCK_AT[v.unlock] <= to).length;
    const parts = [];
    if (nv) parts.push(plural(nv, "visual"));
    if (from < 1 && to >= 1 && cardsOf(pack).length) parts.push(plural(cardsOf(pack).length, "card"));
    if (to >= 6) parts.push("the answer key");
    return parts.length ? "Unlocked " + parts.join(", ") : "";
  }

  // [Working Memory] earlier predictions stay one tap away instead of in your head.
  function earlierAnswers(pack, prog, upTo) {
    const items = [];
    for (let i = 0; i < upTo; i++) {
      const key = STAGES[i].key; if (!key.startsWith("pass")) continue;
      for (const q of questionsFor(pack, key)) if ((prog.answers[q.id] || "").trim()) items.push(el("li", {}, el("span", { class: "muted small" }, STAGES[i].label + ": "), q.text, el("blockquote", {}, prog.answers[q.id])));
    }
    return items.length ? el("details", { class: "panel earlier" }, el("summary", {}, `Your earlier answers (${items.length})`), el("ul", { class: "plain" }, items)) : null;
  }

  // ---------- Read: the paper, rebuilt step by step ----------
  // [Chunking] [Miller's Law] lessons of 2-4 short steps; [Aesthetic-Usability] one idea per screen;
  // [Goal-Gradient] progress per lesson and overall; [Zeigarnik] "continue where you left off".
  function levelSwitch(pack, prog, onChange) {
    const level = prog.level || "simple";
    const mk = (value, label) => el("button", { type: "button", role: "radio", "aria-checked": String(level === value),
      onclick: async () => { if (prog.level === value) return; prog.level = value; await saveProgress(prog); onChange(); } }, label);
    return el("div", { class: "segmented level", role: "radiogroup", "aria-label": "Reading level" }, mk("simple", "Simple"), mk("full", "Full detail"));
  }
  const stepHref = (pack, lesson, n) => `#/pack/${pack.id}/read/${lesson.id}/${n}`;
  function readableVisual(pack, prog, id) {
    const v = visualsOf(pack).find((x) => x.id === id);
    const answers = new Set(((pack.files["answer_key.json"] || {}).answer_visuals) || []);
    if (!v || answers.has(v.id)) return null;
    if (UNLOCK_AT[v.unlock] >= 6 && prog.stage < 6) return null; // debrief material stays hidden
    return visualFigure(pack, v);
  }

  function viewRead(pack, prog, lessonId, stepNo) {
    const lessons = lessonsOf(pack);
    const rp = readingProgress(pack, prog);
    const lesson = lessons.find((l) => l.id === lessonId);
    if (!lesson) {
      const cont = rp.next;
      return el("div", {},
        el("div", { class: "panel readhead" },
          el("h2", {}, rp.read ? "Keep reading" : "Read the paper, one step at a time"),
          el("p", { class: "muted" }, `${plural(lessons.length, "lesson")}, ${rp.total} short steps. Each step comes in a simple version and a full one, with the page it comes from.`),
          progressBar(rp.read, rp.total, "Reading progress"),
          el("p", { class: "small" }, rp.read === rp.total ? "You've read every step." : `${rp.read} of ${rp.total} steps read`),
          (() => { const vid = visualsOf(pack).find((v) => v.type === "video" && visibleVisual(pack, prog, v));
            const locked = !vid && visualsOf(pack).some((v) => v.type === "video");
            return vid ? el("details", { class: "watch" }, el("summary", {}, "▶ Watch the narrated overview"), visualFigure(pack, vid))
              : locked ? el("p", { class: "small muted" }, "🔒 A narrated overview video opens after Pass 1 of the Journey (it gives away the results you predict).") : null; })(),
          el("div", { class: "row actions" },
            cont ? el("a", { class: "btn big", href: stepHref(pack, cont.lesson, cont.n) }, rp.read ? `Continue: ${cont.lesson.title}` : "Start reading")
              : el("a", { class: "btn big", href: stepHref(pack, lessons[0], 1) }, "Read again from the start"),
            levelSwitch(pack, prog, () => rerender(pack, "read")))),
        el("ol", { class: "lessons" }, lessons.map((l, i) => {
          const done = l.steps.filter((s) => (prog.read || {})[s.id]).length;
          return el("li", { class: done === l.steps.length ? "complete" : "" },
            el("a", { href: stepHref(pack, l, Math.min(done + 1, l.steps.length)) },
              el("span", { class: "lnum" }, done === l.steps.length ? "✓" : String(i + 1)),
              el("span", { class: "ltext" }, el("strong", {}, l.title), el("span", { class: "small muted" }, l.why || "")),
              el("span", { class: "small muted lcount" }, `${done}/${l.steps.length}`)));
        })));
    }

    const li = lessons.indexOf(lesson);
    const n = Math.min(Math.max(parseInt(stepNo, 10) || 1, 1), lesson.steps.length);
    const step = lesson.steps[n - 1];
    prog.read = prog.read || {};
    if (!prog.read[step.id]) { prog.read[step.id] = true; saveProgress(prog); }
    award(`${pack.id}:read:${step.id}`, 5, "Read a summary step", pack.id);
    const level = prog.level || "simple";
    const glossary = Object.fromEntries(((pack.files["glossary.json"] || {}).terms || []).map((t) => [t.term.toLowerCase(), t]));
    const questions = Object.fromEntries(["pass1", "pass2", "pass3", "pass4"].flatMap((p) => questionsFor(pack, p)).map((q) => [q.id, q]));
    const terms = (step.terms || []).map((t) => glossary[t.toLowerCase()]).filter(Boolean);
    const check = step.check && questions[step.check];

    const prevHref = n > 1 ? stepHref(pack, lesson, n - 1) : li > 0 ? stepHref(pack, lessons[li - 1], lessons[li - 1].steps.length) : null;
    const nextLesson = lessons[li + 1];
    const nextHref = n < lesson.steps.length ? stepHref(pack, lesson, n + 1) : nextLesson ? stepHref(pack, nextLesson, 1) : `#/pack/${pack.id}/read`;
    const nextLabel = n < lesson.steps.length ? "Next step" : nextLesson ? `Next lesson: ${nextLesson.title}` : "Finish reading";

    // [Flow] arrow keys move between steps
    const onKey = (e) => {
      if (e.target && e.target.closest && e.target.closest("textarea, input")) return;
      if (e.key === "ArrowRight") location.hash = nextHref;
      else if (e.key === "ArrowLeft" && prevHref) location.hash = prevHref;
    };
    document.addEventListener("keydown", onKey); cleanup.push(() => document.removeEventListener("keydown", onKey));

    const readerEl = el("div", { class: "reader" });
    onSwipe(readerEl, () => { haptic("tick"); location.hash = nextHref; }, () => { if (prevHref) { haptic("tick"); location.hash = prevHref; } });
    readerEl.append(
      el("div", { class: "row spread small" },
        el("a", { href: `#/pack/${pack.id}/read` }, "← All lessons"),
        levelSwitch(pack, prog, () => rerender(pack, `read/${lesson.id}/${n}`))),
      el("p", { class: "eyebrow" }, `Lesson ${li + 1} of ${lessons.length} · ${lesson.title}`),
      el("div", { class: "row tight small muted" }, `Step ${n} of ${lesson.steps.length}`),
      progressBar(n, lesson.steps.length, "Lesson progress"),
      el("article", { class: "panel step" + (step.visual && readableVisual(pack, prog, step.visual) ? " has-visual" : "") },
        el("h2", {}, step.heading),
        el("p", { class: level === "simple" ? "steptext simple" : "steptext" }, level === "simple" ? step.simple : step.full),
        step.analogy ? el("p", { class: "analogy" }, el("span", { class: "badge analogy" }, "Analogy, not from the paper"), " ", step.analogy) : null,
        step.visual ? readableVisual(pack, prog, step.visual) : null,
        terms.length ? el("details", { class: "terms" }, el("summary", {}, `Key terms (${terms.length})`),
          el("dl", { class: "glossary" }, terms.flatMap((t) => [el("dt", {}, t.term), el("dd", {}, t.meaning)]))) : null,
        check ? el("details", { class: "check" }, el("summary", {}, "Check yourself"),
          el("p", {}, check.text), el("p", { class: "small muted" }, "Think it through, or write your answer in the Journey. Model answers unlock after the debrief.")) : null,
        el("p", { class: "source small" }, "From the paper: " + loc(step.source))),
      el("div", { class: "actionbar" },
        prevHref ? el("a", { class: "btn secondary", href: prevHref, "aria-label": "Previous step" }, "←") : el("span"),
        el("a", { class: "btn big", href: nextHref }, nextLabel, " →")),
      ANDROID ? el("p", { class: "small muted center swipe-hint" }, "Swipe left for the next step, right to go back") : el("span"));
    return readerEl;
  }

  // ---------- Andrew Ng's journey ----------
  // Ng (CS230, "How to read research papers"): pass 1 title/abstract/figures; pass 2 intro, conclusion,
  // figures again, skim the rest (skip related work); pass 3 the whole paper but skip the maths;
  // pass 4 everything, skipping only what still doesn't make sense. Then his four questions, then
  // re-derive the maths and re-implement the code. The pack's map.json supplies the page ranges.
  const KIND_LABEL = { title: "Title", abstract: "Abstract", intro: "Introduction", related: "Related work", methods: "Method",
    math: "Maths", experiments: "Experiments and results", conclusion: "Conclusion", references: "References", appendix: "Appendix" };
  const NG = {
    pass1: { read: ["title", "abstract"], figures: "each", skim: [], skip: ["intro", "related", "methods", "math", "experiments", "conclusion"],
      tip: "Only the title, the abstract and the figures. Resist reading on." },
    pass2: { read: ["intro", "conclusion"], figures: "again", skim: ["methods", "math", "experiments"], skip: ["related"],
      tip: "Introduction and conclusion carefully, figures again, skim the rest. Skip related work for now." },
    pass3: { read: ["abstract", "intro", "methods", "experiments", "conclusion"], figures: null, skim: ["related"], skip: ["math"],
      tip: "Read the whole paper, but skip over the maths: step around equations and derivations." },
    pass4: { read: ["abstract", "intro", "related", "methods", "math", "experiments", "conclusion"], figures: null, skim: ["appendix"], skip: [],
      tip: "Read everything, maths included. When a part still makes no sense, note it below and move on." },
  };
  function passItems(pack, key) {
    const spec = NG[key]; const map = pack.files["map.json"] || {}; const items = [];
    const sections = map.sections || [];
    const range = (s) => s.pages[0] === s.pages[1] ? `p. ${s.pages[0]}` : `pp. ${s.pages[0]}–${s.pages[1]}`;
    for (const verb of ["read", "skim"]) for (const kind of spec[verb]) for (const s of sections.filter((x) => x.kind === kind))
      items.push({ id: `${key}:${verb}:${kind}`, verb, kind, label: `${verb === "read" ? "Read" : "Skim"}: ${KIND_LABEL[kind] || kind}`, where: range(s), page: s.pages[0] });
    if (spec.figures === "each") for (const f of map.figures || [])
      items.push({ id: `${key}:fig:${f.id}`, verb: "look", figs: [f], label: `Look at ${f.id.replace(/^fig/, "Figure ").replace(/^tab/, "Table ")}`, where: `p. ${f.page}`, page: f.page, why: f.why_it_matters });
    if (spec.figures === "again" && (map.figures || []).length)
      items.push({ id: `${key}:figs-again`, verb: "look", figs: map.figures, label: "Look at all the figures again", where: `from p. ${map.figures[0].page}`, page: map.figures[0].page });
    const skips = spec.skip.filter((k) => sections.some((s) => s.kind === k)).map((k) => KIND_LABEL[k] || k);
    if (key === "pass3" && !sections.some((s) => s.kind === "math")) skips.push("equations inside the method (Eq. 1, 2, 3)");
    return { items, skips };
  }
  const passPages = (pack, key) => passItems(pack, key).items.filter((i) => i.verb !== "look").map((i) => i.page);
  function bossCards(pack, key) {
    const order = { pass2: 0, pass3: 1, pass4: 2 }[key];
    if (order === undefined) return [];
    const sorted = cardsOf(pack).slice().sort((a, b) => a.source.page - b.source.page);
    const size = Math.ceil(sorted.length / 3);
    return sorted.slice(order * size, order * size + size).slice(0, 6);
  }
  function helperSteps(pack, key) {
    const spec = NG[key]; const map = pack.files["map.json"] || {};
    const ranges = (map.sections || []).filter((s) => spec.read.includes(s.kind) || spec.skim.includes(s.kind)).map((s) => s.pages);
    const inRange = (p) => ranges.some(([a, b]) => p >= a && p <= b);
    return lessonsOf(pack).map((l) => [l, l.steps.filter((s) => inRange(s.source.page))]).filter(([, st]) => st.length);
  }

  // What "reading a part" shows: the pack's explanation of that section, at the chosen level.
  // Pass 3 steps around the maths (Ng); pass 4 shows it. Figures show their picture when it won't spoil a prediction.
  function levelSwitchInline(pack, prog) {
    return levelSwitch(pack, prog, () => {
      if (isWide()) { const sel = document.querySelector("ul.readlist li.selected .rl-read summary"); route().then(() => { if (sel) { const all = [...document.querySelectorAll("ul.readlist li .rl-read summary")]; const i = [...document.querySelectorAll("ul.readlist li")].findIndex((li) => li.querySelector("summary") && li.querySelector("strong").textContent === sel.closest("li").querySelector("strong").textContent); if (i >= 0) all[i].click(); } }); return; }
      document.querySelectorAll(".rl-read").forEach((d) => { const b = d.querySelector(".rl-body"); const was = d.open; b.replaceChildren(); d.open = false; if (was) d.open = true; });
    });
  }
  // A "look at" item shows the paper's own figure or table (reproduced with the paper's permission),
  // then the pack's simplified redraw. Results that a Pass 1 prediction depends on sit behind one tap.
  function figureContent(pack, prog, f) {
    const answers = new Set(((pack.files["answer_key.json"] || {}).answer_visuals) || []);
    const byId = (id) => visualsOf(pack).find((x) => x.id === id);
    const originals = (f.originals || []).map(byId).filter(Boolean).map((v) => visualFigure(pack, v));
    const redraw = f.visual && byId(f.visual);
    const redrawOk = redraw && !answers.has(redraw.id) && UNLOCK_AT[redraw.unlock] < 6;
    const out = [];
    const label = f.id.replace(/^fig/, "Figure ").replace(/^tab/, "Table ");
    if (redrawOk && redraw.type === "predict_blank" && prog.stage === 0)
      out.push(el("p", { class: "small note" }, "Predict first: sketch your guess on this blank, then reveal the real table."), visualFigure(pack, redraw));
    if (originals.length && f.spoiler && prog.stage === 0) {
      const hold = el("div", { class: "reveal" });
      hold.append(el("p", { class: "small muted" }, `${label} shows results that your Pass 1 predictions are about. Make your guesses first.`),
        el("button", { class: "btn secondary", onclick: () => hold.replaceChildren(...originals) }, `Reveal ${label}`));
      out.push(hold);
    } else out.push(...originals);
    if (redrawOk && !(redraw.type === "predict_blank" && prog.stage === 0) && !(f.spoiler && prog.stage === 0))
      out.push(el("details", { class: "redraw" }, el("summary", {}, originals.length ? "Simplified redraw" : "Picture"), visualFigure(pack, redraw)));
    if (!out.length) out.push(el("p", { class: "small muted" }, "No picture for this one in the pack."));
    return out;
  }
  function partContent(pack, prog, passKey, it) {
    const level = prog.level || "simple";
    if (it.figs) return it.figs.map((f) => el("div", { class: "fig-part" },
      el("p", {}, el("strong", {}, f.id.replace(/^fig/, "Figure ").replace(/^tab/, "Table ")), el("span", { class: "muted small" }, ` · p. ${f.page}`), " ", f.why_it_matters || ""),
      ...figureContent(pack, prog, f)));
    if (it.kind === "title") {
      const m = pack.files["manifest.json"];
      return [el("p", { class: "lead" }, m.title), el("p", { class: "small muted" }, (m.authors || []).join(", "))];
    }
    const steps = lessonsOf(pack).flatMap((l) => l.steps).filter((s) => s.section === it.kind);
    const hideMath = passKey === "pass3";
    const shown = steps.filter((s) => !(hideMath && s.math)); const skipped = steps.length - shown.length;
    if (!steps.length) return [el("p", { class: "muted small" }, "The pack has no explanation for this part yet.")];
    return [
      ...shown.map((s) => el("div", { class: "part-step" + (s.math ? " math" : "") },
        el("h4", {}, s.heading, s.math ? el("span", { class: "badge medium" }, "maths") : null),
        el("p", {}, level === "simple" ? s.simple : s.full),
        s.analogy ? el("p", { class: "small" }, el("span", { class: "badge analogy" }, "Analogy, not from the paper"), " ", s.analogy) : null,
        s.visual && it.verb === "read" ? readableVisual(pack, prog, s.visual) : null,
        el("p", { class: "small muted" }, "From the paper: " + loc(s.source)))),
      skipped ? el("p", { class: "small note" }, `Skipping ${plural(skipped, "maths step")} on this pass, as Ng suggests. They come back in Pass 4.`) : null,
    ].filter(Boolean);
  }

  // ---------- the journey screen ----------
  function viewStudy(pack, prog) {
    const st = prog.stage; const stage = STAGES[st];
    const map = pack.files["map.json"] || {}; const m = pack.files["manifest.json"];
    const stageVisuals = visualsOf(pack).filter((v) => UNLOCK_AT[v.unlock] === st && v.type !== "card_visual" && !v.simple);
    prog.ticks = prog.ticks || {}; prog.confusions = prog.confusions || []; prog.deep = prog.deep || {};
    const out = el("div");
    const header = el("div", { class: "stagehead" }, el("h2", {}, stage.title),
      stage.box ? el("span", { class: "badge" }, "Time box " + stage.box) : null);

    if (stage.key.startsWith("pass")) {
      const list = questionsFor(pack, stage.key);
      const { items, skips } = passItems(pack, stage.key);
      const nextTo = st === 0 ? 1 : st + 1;
      const done = () => items.filter((i) => prog.ticks[i.id]).length;
      const answered = () => list.filter((x) => (prog.answers[x.id] || "").trim()).length;
      // [Goal-Gradient] one bar for the whole pass: reading ticks + answers
      const count = el("span", { class: "small" }); const bar = el("div", { class: "progress slim" }, el("span"));
      const next = el("button", { class: "btn big", onclick: async () => {
        await award(`${pack.id}:clear:${stage.key}`, 100, `${stage.title} cleared`, pack.id,
          stage.key === "pass1" ? ["skimmer"] : stage.key === "pass4" ? ["deep-diver"] : []);
        celebrate(`${stage.title} cleared!`);
        advance(pack, prog, nextTo, unlockSummary(pack, st, nextTo));
      } }, st === 4 ? "Clear the pass → Debrief" : `Clear the pass → ${STAGES[nextTo].label}`);
      const update = () => {
        const total = items.length + list.length; const have = done() + answered();
        count.textContent = have === total ? "Ready to clear this pass" : `${done()} of ${items.length} read · ${answered()} of ${list.length} answered`;
        bar.firstChild.style.width = Math.round((100 * have) / Math.max(total, 1)) + "%";
        next.disabled = have < total;
      };
      // desktop reading pane: the checklist drives it; "Done, next part" ticks and moves on [Flow]
      const rows = []; const pane = isWide() ? el("aside", { class: "part-pane", "aria-live": "polite" }) : null;
      function showInPane(i) {
        const r = rows[i]; if (!r || !pane) return;
        rows.forEach((x, j) => x.li.classList.toggle("selected", j === i));
        const nextIdx = rows.findIndex((x, j) => j > i && !x.box.checked);
        const done = el("button", { class: "btn big", onclick: () => {
          if (!r.box.checked) { r.box.checked = true; r.box.dispatchEvent(new Event("change")); }
          if (nextIdx >= 0) showInPane(nextIdx); else { pane.replaceChildren(el("div", { class: "pane-done" }, el("h3", {}, "Every part of this pass is read"), el("p", { class: "muted" }, "Answer the questions on the left, then clear the pass."))); rows.forEach((x) => x.li.classList.remove("selected")); }
        } }, r.box.checked ? (nextIdx >= 0 ? "Next part →" : "Close") : nextIdx >= 0 ? "Done, next part →" : "Done");
        pane.replaceChildren(
          el("div", { class: "pane-head" }, el("span", { class: "eyebrow" }, `${stage.title} · part ${i + 1} of ${rows.length}`),
            el("h3", {}, r.it.label), el("span", { class: "small muted" }, "Paper " + r.it.where)),
          el("div", { class: "pane-body" }, ...partContent(pack, prog, stage.key, r.it)),
          el("div", { class: "pane-foot" }, i > 0 ? el("button", { class: "btn secondary", onclick: () => showInPane(i - 1) }, "← Previous") : el("span"), done));
        pane.scrollTop = 0;
      }
      // Ng's instruction for this pass, then exactly what to read
      out.append(el("div", { class: "panel" }, header,
        el("p", { class: "ngtip" }, el("span", { class: "badge high" }, "Andrew Ng's method"), " ", NG[stage.key].tip),
        el("p", { class: "small muted" }, "Open each part, read it here, then tick it off.", " ", levelSwitchInline(pack, prog)),
        el("ul", { class: "readlist" }, items.map((it, idx) => {
          const box = el("input", { type: "checkbox", id: "t-" + it.id, checked: prog.ticks[it.id] ? true : null, "aria-label": "Done: " + it.label });
          box.addEventListener("change", async () => {
            prog.ticks[it.id] = box.checked; await saveProgress(prog); update();
            if (box.checked) { haptic("tick"); award(`${pack.id}:tick:${it.id}`, 10, it.label, pack.id); }
          });
          const body = el("div", { class: "rl-body" });
          const reader = el("details", { class: "rl-read" }, el("summary", {}, it.verb === "look" ? "Look at it here" : it.verb === "skim" ? "Skim it here" : "Read it here"), body);
          reader.addEventListener("toggle", () => { if (reader.open && !body.childNodes.length) body.append(...partContent(pack, prog, stage.key, it)); });
          const li = el("li", { class: it.verb },
            el("div", { class: "rl-head" }, box, el("label", { for: "t-" + it.id, class: "rl-text" }, el("strong", {}, it.label), el("span", { class: "muted small" }, " · paper " + it.where))),
            reader);
          rows.push({ it, box, li });
          // desktop: open the part in the reading pane instead of expanding in place
          reader.querySelector("summary").addEventListener("click", (e) => { if (pane) { e.preventDefault(); showInPane(idx); } });
          return li;
        })),
        skips.length ? el("p", { class: "small muted" }, "Skip on this pass: " + skips.join(", ") + ".") : null));
      // lessons as a helper, closed by default so they don't spoil the predictions
      const helpers = st === 0 ? [] : helperSteps(pack, stage.key);
      if (helpers.length) out.append(el("details", { class: "panel helper" },
        el("summary", {}, `Stuck? Explain these parts (${helpers.reduce((n, [, s]) => n + s.length, 0)} short steps)`),
        el("div", { class: "row" }, levelSwitch(pack, prog, () => rerender(pack, "journey"))),
        ...helpers.map(([l, steps]) => el("details", { class: "helper-lesson" }, el("summary", {}, l.title),
          ...steps.map((s) => el("div", { class: "helper-step" }, el("strong", {}, s.heading),
            el("p", {}, (prog.level || "simple") === "simple" ? s.simple : s.full),
            s.analogy ? el("p", { class: "small" }, el("span", { class: "badge analogy" }, "Analogy, not from the paper"), " ", s.analogy) : null,
            el("p", { class: "small muted" }, loc(s.source))))))));
      out.append(el("div", { class: "panel" }, el("h3", {}, "Questions for this pass"),
        ...list.map((x, i) => questionBlock(prog, x, i + 1, list.length, null, update))));
      if (stage.key === "pass4") out.append(confusionPanel(pack, prog));
      const boss = bossCards(pack, stage.key);
      if (boss.length) out.append(bossPanel(pack, prog, stage, boss));
      out.append(el("div", { class: "actionbar" }, el("div", { class: "actioninfo" }, count, bar), next));
      update();
      if (st >= 2) { const e = earlierAnswers(pack, prog, st); if (e) out.append(e); }
      if (stageVisuals.length) out.append(el("h3", { class: "section" }, "Pictures for this pass"), el("div", { class: "grid" }, stageVisuals.map((v) => visualFigure(pack, v))));
      if (pane) {
        out.replaceChildren(el("div", { class: "journey-grid" }, el("div", { class: "j-left" }, ...out.childNodes), pane));
        const first = rows.findIndex((x) => !x.box.checked); showInPane(first >= 0 ? first : 0);
      }
    } else if (stage.key === "triage_done") {
      const rec = m.depth_recommendation || {};
      const decide = async (go) => {
        await award(`${pack.id}:triage`, 30, "Triage call made", pack.id, ["decider"]);
        if (go) { prog.stopped = false; advance(pack, prog, 2, unlockSummary(pack, 1, 2)); }
        else { prog.stopped = true; await saveProgress(prog); rerender(pack, "journey"); }
      };
      out.append(el("div", { class: "panel" }, header,
        el("p", { class: "ngtip" }, el("span", { class: "badge high" }, "Andrew Ng's method"), " Survey widely, go deep selectively. After the first pass, decide whether this paper earns more of your time."),
        el("p", { class: "lead" }, map.one_sentence || ""),
        rec.value ? el("p", { class: "muted" }, `The pack suggests "${rec.value}" depth: ${rec.reason || ""}`) : null,
        prog.stopped ? el("p", { class: "note" }, "You stopped here. The cards stay in your review queue.") : null,
        el("div", { class: "row actions" },
          el("button", { class: "btn big", onclick: () => decide(true) }, "Go deeper → Pass 2"),
          prog.stopped ? null : el("button", { class: "btn secondary", onclick: () => decide(false) }, "Stop here, keep the cards"))));
      out.append(el("div", { class: "grid" }, stageVisuals.map((v) => visualFigure(pack, v))));
    } else if (stage.key === "debrief") {
      const list = (pack.files["questions.json"] || {}).debrief || [];
      const count = el("span", { class: "small" });
      const go = el("button", { class: "btn big", onclick: async () => {
        await award(`${pack.id}:debrief`, 150, "Ng's four questions answered", pack.id, ["four-questions"]);
        celebrate("Debrief done: answers unlocked");
        advance(pack, prog, 6, unlockSummary(pack, 5, 6));
      } }, "Submit → see the answers");
      const update = () => { const d = list.filter((x) => (prog.debrief[x.key] || "").trim()).length; count.textContent = `${d} of ${list.length} answered`; go.disabled = d < list.length; };
      const follow = ((pack.files["refs.json"] || {}).refs || []).filter((r) => ["use", "own"].includes(r.suggested_decision));
      out.append(el("div", { class: "panel" }, header,
        el("p", { class: "ngtip" }, el("span", { class: "badge high" }, "Andrew Ng's method"), " Answer his four questions from memory, then compare with the key."),
        ...list.map((x, i) => questionBlock(prog, x, i + 1, list.length, "debrief", update)),
        follow.length ? el("div", { class: "follow" }, el("h3", {}, "References worth following"), refList(pack, follow)) : null),
        el("div", { class: "actionbar" }, el("div", { class: "actioninfo" }, count), go));
      update();
    } else {
      const ders = (pack.files["derivations.json"] || {}).derivations || [];
      const due = dueCards(pack, prog).length;
      out.append(el("div", { class: "panel finish" }, el("h2", {}, "You've cleared all four passes"),
        el("p", {}, "Compare your answers with the key. Then do what Andrew Ng says turns reading into real understanding: re-derive the maths and rebuild the code yourself."),
        el("div", { class: "row actions" }, el("a", { class: "btn big", href: `#/pack/${pack.id}/answers` }, "Compare with the answer key"),
          el("a", { class: "btn secondary", href: `#/pack/${pack.id}/cards` }, due ? `Review ${plural(due, "card")}` : "Cards"))));
      if (ders.length) out.append(el("div", { class: "panel" }, el("h2", {}, "Re-derive it from scratch"),
        el("p", { class: "muted small" }, "Cover the paper, derive on paper, then tick. Without the hint: 60 XP. With it: 30 XP."),
        ...ders.map((d, i) => {
          const hint = el("p", { class: "hint", hidden: !prog.hints[d.id] }, "Hint: " + d.hint_step);
          const btn = el("button", { class: "btn secondary", hidden: !!prog.hints[d.id], onclick: async () => { prog.hints[d.id] = true; hint.hidden = false; btn.hidden = true; await saveProgress(prog); } }, "Show one hint step");
          return el("div", { class: "question" }, el("div", { class: "qhead" }, el("span", { class: "qnum" }, `${i + 1} of ${ders.length}`)),
            el("p", { class: "qtext" }, d.what), el("p", { class: "small muted" }, loc(d.where)), btn, hint,
            deepCheck(pack, prog, `der:${d.id}`, "I re-derived it", () => prog.hints[d.id] ? 30 : 60, () => prog.hints[d.id] ? [] : ["deriver"]));
        })));
      out.append(el("div", { class: "panel" }, el("h2", {}, "Rebuild it"),
        el("p", { class: "muted small" }, "Ng's advice: run the authors' code, then re-implement the core yourself and compare."),
        deepCheck(pack, prog, "code:run", "Found and ran the authors' code", () => 50),
        deepCheck(pack, prog, "code:rebuild", "Re-implemented the core from scratch", () => 50),
        deepCheck(pack, prog, "code:compare", "Compared my version's behaviour with theirs", () => 50)));
      if (prog.confusions.length) out.append(confusionPanel(pack, prog, true));
      const deep = visualsOf(pack).filter((v) => v.unlock === "deep");
      if (deep.length) out.append(el("h3", { class: "section" }, "Deep visuals"), el("div", { class: "grid" }, deep.map((v) => visualFigure(pack, v))));
    }
    return out;
  }

  function deepCheck(pack, prog, key, label, xp, badges) {
    const box = el("input", { type: "checkbox", id: "d-" + key, checked: prog.deep[key] ? true : null });
    box.addEventListener("change", async () => {
      prog.deep[key] = box.checked; await saveProgress(prog);
      if (box.checked) award(`${pack.id}:deep:${key}`, xp(), label, pack.id, badges ? badges() : []);
    });
    return el("label", { class: "deepcheck", for: "d-" + key }, box, " ", label);
  }

  // Pass 4: "skip the parts that don't make sense" - but write them down and come back
  function confusionPanel(pack, prog, revisit) {
    const listEl = el("ul", { class: "plain confusions" });
    const draw = () => listEl.replaceChildren(...prog.confusions.map((c, i) => el("li", { class: c.resolved ? "resolved" : "" },
      el("label", {}, el("input", { type: "checkbox", checked: c.resolved ? true : null, onchange: async (e) => {
        c.resolved = e.target.checked; await saveProgress(prog); draw();
        if (c.resolved) award(`${pack.id}:resolved:${i}`, 20, "Cleared up a confusing part", pack.id);
      } }), " ", c.text))));
    const input = el("input", { type: "search", placeholder: "e.g. why PE(pos+k) is linear in PE(pos)", "aria-label": "Something that didn't make sense" });
    const add = el("button", { class: "btn secondary", onclick: async () => {
      const t = input.value.trim(); if (!t) return;
      prog.confusions.push({ text: t, at: Date.now(), resolved: false }); input.value = ""; await saveProgress(prog); draw();
      award(`${pack.id}:confusion:${prog.confusions.length}`, 15, "Noted a confusing part", pack.id, ["honest"]);
    } }, "Add");
    draw();
    return el("div", { class: "panel" }, el("h3", {}, revisit ? "Come back to these" : "Parts that didn't make sense yet"),
      el("p", { class: "small muted" }, revisit ? "Tick each one once it clicks: re-read, ask someone, or follow a reference." : "Ng: skip what doesn't make sense, but don't lose it. Note it here to revisit."),
      revisit ? null : el("div", { class: "row" }, input, add), listEl);
  }

  // Boss quiz: a short, timed run of this pass's cards. Optional bonus; win with 60% or more.
  function bossPanel(pack, prog, stage, cards) {
    const box = el("div", { class: "panel boss" });
    const intro = () => box.replaceChildren(
      el("div", { class: "row spread" }, el("h3", {}, "⚔️ Boss quiz"), el("span", { class: "badge medium" }, "+50 XP")),
      el("p", { class: "small muted" }, `${plural(cards.length, "card")}, 90 seconds. Say the answer to yourself, reveal, be honest. Win with 60% or more.`),
      el("button", { class: "btn", onclick: start }, "Start the boss quiz"));
    function start() {
      let i = 0, right = 0, left = 90; const timer = el("span", { class: "badge warn" });
      const tick = setInterval(() => { left--; timer.textContent = `${left}s`; if (left <= 0) end(); }, 1000);
      cleanup.push(() => clearInterval(tick));
      function show() {
        if (i >= cards.length) return end();
        const c = cards[i]; timer.textContent = `${left}s`;
        const back = el("div", { hidden: true }, el("p", {}, c.back),
          el("div", { class: "grade" }, el("button", { class: "btn secondary", onclick: () => { i++; show(); } }, "Missed"),
            el("button", { class: "btn", onclick: () => { right++; i++; show(); } }, "Got it")));
        const rev = el("button", { class: "btn wide", onclick: () => { back.hidden = false; rev.hidden = true; } }, "Reveal");
        box.replaceChildren(el("div", { class: "row spread" }, el("strong", {}, `⚔️ ${i + 1} / ${cards.length}`), timer),
          progressBar(i, cards.length, "Boss progress"), el("p", { class: "face" }, c.front), rev, back);
      }
      async function end() {
        clearInterval(tick);
        const won = right / cards.length >= 0.6;
        box.replaceChildren(el("h3", {}, won ? "🏆 Boss defeated" : "The boss wins this round"),
          el("p", {}, `${right} of ${cards.length} right${left > 0 ? `, ${left}s to spare` : ""}.`),
          el("button", { class: "btn secondary", onclick: intro }, won ? "Play again" : "Try again"));
        if (won) {
          await award(`${pack.id}:boss:${stage.key}`, 50, `Beat the ${stage.label} boss`, pack.id, right === cards.length ? ["boss", "flawless"] : ["boss"]);
          celebrate("Boss defeated!");
        }
      }
      show();
    }
    intro();
    return box;
  }

  // A picture opens when Practice reaches its stage, when you read the lesson step that shows it,
  // or, once you've read every step, for everything except answer and debrief material.
  function visibleVisual(pack, prog, v) {
    if (unlocked(v, prog.stage)) return true;
    const answers = new Set(((pack.files["answer_key.json"] || {}).answer_visuals) || []);
    if (answers.has(v.id) || UNLOCK_AT[v.unlock] >= 6) return false;
    const rp = readingProgress(pack, prog);
    if (rp.total && rp.read === rp.total) return true;
    return rp.steps.some((x) => x.step.visual === v.id && (prog.read || {})[x.step.id]);
  }
  // [Law of Common Region] grouped: what the lessons use, then the rest
  function viewVisuals(pack, prog) {
    const all = visualsOf(pack).filter((v) => v.type !== "card_visual");
    const open = all.filter((v) => visibleVisual(pack, prog, v));
    const locked = all.length - open.length;
    const inLessons = new Set(lessonsOf(pack).flatMap((l) => l.steps.map((s) => s.visual)).filter(Boolean));
    const groups = [["From the lessons", open.filter((v) => inLessons.has(v.id))],
      ["Simple pictures", open.filter((v) => !inLessons.has(v.id) && v.simple)],
      ["More pictures", open.filter((v) => !inLessons.has(v.id) && !v.simple)]].filter(([, l]) => l.length);
    return el("div", {},
      locked ? el("p", { class: "muted" }, `${plural(locked, "more picture")} open as you read and practise.`) : null,
      ...groups.map(([label, list]) => el("section", {}, el("h3", { class: "section" }, label), el("div", { class: "grid" }, list.map((v) => visualFigure(pack, v))))));
  }

  // [Flow] keyboard: Space shows the answer, 1 = missed, 2 = got it. [Goal-Gradient] session bar.
  function viewCards(pack, prog) {
    const cards = cardsOf(pack);
    const due = dueCards(pack, prog);
    const vis = Object.fromEntries(visualsOf(pack).map((v) => [v.id, v]));
    const imageFor = (ref) => {
      if (!ref) return null;
      const v = vis[ref] || visualsOf(pack).find((x) => x.file === ref);
      if (v && !unlocked(v, prog.stage)) return null;
      const src = blobUrl(pack, v ? v.file : ref);
      return src ? el("img", { class: "cardimg", src, alt: v ? v.alt_text : "Card picture" }) : null;
    };
    const total = due.length; let got = 0, missed = 0;
    const wrap = el("div", { class: "flashcard" });
    let keyHandler = null;
    const finish = () => {
      const upcoming = cards.map((c) => (prog.cards[c.id] || {}).due || 0).filter((d) => d > Date.now()).sort((a, b) => a - b)[0];
      // [Peak-End Rule] end each session with a clear summary
      wrap.replaceChildren(el("div", { class: "panel empty" },
        el("h2", {}, total ? "Session done" : "Nothing due right now"),
        total ? el("p", {}, `${got} remembered, ${missed} to see again sooner.`) : null,
        el("p", { class: "muted" }, upcoming ? "Next card is due " + new Date(upcoming).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }) + "." : ""),
        el("a", { class: "btn secondary", href: `#/pack/${pack.id}/read` }, "Back to reading")));
    };
    const show = (i) => {
      if (i >= due.length) return finish();
      const c = due[i]; const s = prog.cards[c.id] || { box: 0 };
      const back = el("div", { class: "answer-side", hidden: true }, el("p", { class: "face" }, c.back), imageFor(c.back_image),
        el("p", { class: "small muted" }, "Check it: " + loc(c.source)),
        el("div", { class: "grade" },
          el("button", { class: "btn secondary big", onclick: () => grade(false) }, "Missed it", el("kbd", {}, "1")),
          el("button", { class: "btn big", onclick: () => grade(true) }, "Got it", el("kbd", {}, "2"))));
      const reveal = el("button", { class: "btn big wide", onclick: () => { back.hidden = false; reveal.hidden = true; } }, "Show answer", el("kbd", {}, "Space"));
      async function grade(ok) {
        const box = ok ? Math.min(s.box + 1, INTERVALS.length) : 0;
        prog.cards[c.id] = { box, due: ok ? today() + INTERVALS[box - 1] * DAY : Date.now(), seen: (s.seen || 0) + 1 };
        haptic(ok ? "confirm" : "reject");
        if (ok) { got++; award(`${pack.id}:card:${c.id}:${dayKey(Date.now())}`, 10, "Remembered a card", pack.id); }
        else { missed++; due.push(c); } // see it again this session
        await saveProgress(prog); show(i + 1);
      }
      keyHandler = (e) => {
        const t = e.target && e.target.closest ? e.target : null;
        if (t && t.closest("textarea, input")) return;
        if (e.key === " " && !reveal.hidden) { if (t && t.closest("button")) return; e.preventDefault(); reveal.click(); }
        else if (!back.hidden && e.key === "1") grade(false);
        else if (!back.hidden && e.key === "2") grade(true);
      };
      wrap.replaceChildren(
        el("div", { class: "row spread small muted" }, el("span", {}, `Card ${Math.min(i + 1, due.length)} of ${due.length}`), el("span", { class: "badge" }, c.type)),
        progressBar(i, due.length, "Session progress"),
        el("div", { class: "panel card" }, el("p", { class: "face" }, c.front), imageFor(c.front_image), reveal, back,
          ANDROID ? el("p", { class: "small muted center swipe-hint" }, "Tap to reveal. Then swipe right if you got it, left if you missed it.") : null));
      // [Flow] Android: tap the card to reveal, swipe to grade
      const cardEl = wrap.querySelector(".panel.card");
      if (ANDROID) {
        cardEl.addEventListener("click", (e) => { if (!e.target.closest("button, a, img") && !reveal.hidden) reveal.click(); });
        onSwipe(cardEl, () => { if (!back.hidden) grade(false); }, () => { if (!back.hidden) grade(true); });
      }
    };
    const onKey = (e) => keyHandler && keyHandler(e);
    document.addEventListener("keydown", onKey); cleanup.push(() => document.removeEventListener("keydown", onKey));
    show(0);
    return el("div", {}, wrap,
      el("p", { class: "small muted center" }, "A card you remember comes back after 1, 3, 7, 14, 30, then 60 days."));
  }

  // [Hick's Law] four reference views folded into one tab with a small switcher
  function viewReference(pack, prog, sub) {
    const st = prog.stage;
    const subs = [["claims", "Claims", st >= 1], ["simple", "Simply put", st >= 1], ["glossary", "Glossary", !!pack.files["glossary.json"]], ["refs", "Papers it cites", true], ["check", "Check the pack", true]].filter(([, , ok]) => ok);
    if (!subs.length) return el("p", { class: "panel muted" }, "Reference material opens after Pass 1.");
    if (!subs.some(([k]) => k === sub)) sub = subs[0][0];
    const seg = el("div", { class: "segmented", role: "tablist" }, subs.map(([k, label]) =>
      el("a", { href: `#/pack/${pack.id}/reference/${k}`, role: "tab", "aria-selected": String(k === sub) }, label)));
    const body = { claims: refClaims, simple: refSimple, glossary: refGlossary, refs: refPapers, check: refCheck }[sub](pack, prog);
    return el("div", {}, st < 1 ? el("p", { class: "muted small" }, "Claims, the plain-language layer and cited papers open after Pass 1.") : null, seg, body);
  }

  function refClaims(pack) {
    const map = pack.files["map.json"] || {}; const claims = (pack.files["claims.json"] || {}).claims || [];
    return el("div", {},
      el("div", { class: "panel" }, el("h2", {}, "In one sentence"), el("p", { class: "lead" }, map.one_sentence || "")),
      // [Chunking] claims as separate cards, not a dense table
      el("div", { class: "panel" }, el("h2", {}, "Claims"), el("p", { class: "small muted" }, "Open each one at its page before you trust it."),
        el("ol", { class: "claims" }, claims.map((c) => el("li", {}, el("p", {}, c.paraphrase),
          el("div", { class: "row tight small" }, el("span", { class: "muted" }, loc(c.evidence)), el("span", { class: "badge " + c.confidence }, c.confidence + " confidence")))))),
      el("details", { class: "panel" }, el("summary", {}, "What you need to know first"),
        el("ul", {}, (map.prerequisites || []).map((p) => el("li", {}, el("strong", {}, p.term), ": ", p.why)))),
      el("details", { class: "panel" }, el("summary", {}, "Figures and tables that matter"),
        el("ul", {}, (map.figures || []).map((f) => el("li", {}, el("strong", {}, f.id + ", p. " + f.page), ": ", f.why_it_matters)))),
      el("details", { class: "panel" }, el("summary", {}, "Where things are in the paper"),
        el("p", {}, (map.sections || []).map((s) => `${s.kind} pp. ${s.pages[0]}–${s.pages[1]}`).join(" · "))));
  }

  function refSimple(pack, prog) {
    const s = (pack.files["map.json"] || {}).simple || {};
    const claims = Object.fromEntries(((pack.files["claims.json"] || {}).claims || []).map((c) => [c.id, c]));
    const vis = visualsOf(pack).filter((v) => v.simple && unlocked(v, prog.stage));
    return el("div", {},
      el("div", { class: "panel" }, el("h2", {}, "The whole idea"), el("p", { class: "lead" }, s.one_line || "")),
      el("div", { class: "panel" }, el("h2", {}, "Claims, simply"),
        el("ol", { class: "claims" }, (s.claims || []).map((c) => el("li", {}, el("p", {}, c.simple),
          c.analogy ? el("p", { class: "small" }, el("span", { class: "badge analogy" }, "Analogy, not from the paper"), " ", c.analogy) : null,
          claims[c.claim_id] ? el("p", { class: "small muted" }, loc(claims[c.claim_id].evidence)) : null)))),
      el("div", { class: "panel" }, el("h2", {}, "Words, simply"), el("ul", {}, (s.terms || []).map((t) => el("li", {}, el("strong", {}, t.term), ": ", t.simple)))),
      vis.length ? el("div", { class: "grid" }, vis.map((v) => visualFigure(pack, v))) : null);
  }

  function refGlossary(pack) {
    const terms = ((pack.files["glossary.json"] || {}).terms || []).slice().sort((a, b) => a.term.localeCompare(b.term));
    const list = el("dl", { class: "glossary" }); const search = el("input", { type: "search", placeholder: `Search ${terms.length} terms…`, "aria-label": "Search terms" });
    const draw = () => { const q = search.value.toLowerCase();
      const hits = terms.filter((t) => (t.term + " " + t.meaning).toLowerCase().includes(q));
      list.replaceChildren(...(hits.length ? hits.flatMap((t) => [el("dt", {}, t.term, el("span", { class: "small muted" }, " · p. " + t.first_page)), el("dd", {}, t.meaning)]) : [el("p", { class: "muted" }, "No matching terms.")])); };
    search.addEventListener("input", draw); draw();
    return el("div", { class: "panel" }, search, list);
  }

  function refPapers(pack) {
    const f = pack.files["refs.json"] || {}; const refs = f.refs || [];
    const groups = [["Worth following", ["use", "own"]], ["Worth a skim", ["scan"]], ["Can skip", ["skip"]]];
    // [Chunking] [Selective Attention] the few worth following are shown; the rest are folded
    return el("div", {},
      el("p", { class: "small muted" }, "Papers already in your library get an \"Open its pack\" button. Add others to your reading list. Links start unverified."),
      ...groups.map(([label, ds]) => [label, refs.filter((r) => ds.includes(r.suggested_decision))]).filter(([, l]) => l.length)
        .map(([label, list], i) => el("details", { class: "panel", open: i === 0 ? true : null }, el("summary", {}, `${label} (${list.length})`), refList(pack, list))),
      f.unparsed && f.unparsed.length ? el("p", { class: "small muted" }, "Not parsed: " + f.unparsed.join(", ")) : null);
  }


  function viewAnswers(pack, prog) {
    const key = pack.files["answer_key.json"] || {}; const q = pack.files["questions.json"] || {};
    const ans = Object.fromEntries((key.quiz || []).map((a) => [a.question_id, a]));
    const pair = (mine, model, where) => el("div", { class: "compare" },
      el("div", {}, el("h4", {}, "You wrote"), el("p", {}, mine || "—")),
      el("div", { class: "model" }, el("h4", {}, "Model answer"), el("p", {}, model || "—"), where ? el("p", { class: "small muted" }, loc(where)) : null));
    const d = key.debrief || {};
    const claims = Object.fromEntries(((pack.files["claims.json"] || {}).claims || []).map((c) => [c.id, c]));
    const vis = Object.fromEntries(visualsOf(pack).map((v) => [v.id, v]));
    // [Chunking] one collapsible section per pass, the first one open
    const passSections = ["pass1", "pass2", "pass3", "pass4"].map((p, i) => [STAGES[[0, 2, 3, 4][i]], q[p] || []]).filter(([, l]) => l.length)
      .map(([s, list], i) => el("details", { class: "panel", open: i === 0 ? true : null }, el("summary", {}, `${s.title} (${list.length})`),
        ...list.map((x) => el("div", { class: "question" }, el("p", { class: "qtext" }, x.text), pair(prog.answers[x.id], ans[x.id] && ans[x.id].answer, ans[x.id] && ans[x.id].where)))));
    return el("div", {},
      ...(key.answer_visuals || []).filter((id) => vis[id]).map((id) => visualFigure(pack, vis[id])),
      el("details", { class: "panel", open: true }, el("summary", {}, "Debrief"),
        ...(q.debrief || []).map((x) => el("div", { class: "question" }, el("p", { class: "qtext" }, x.text),
          pair(prog.debrief[x.key], Array.isArray(d[x.key]) ? d[x.key].join("\n") : d[x.key])))),
      ...passSections,
      el("details", { class: "panel" }, el("summary", {}, "Caveats for each claim"),
        el("ol", { class: "claims" }, (key.claim_notes || []).map((n) => el("li", {},
          el("p", { class: "small muted" }, claims[n.claim_id] ? claims[n.claim_id].paraphrase : n.claim_id), el("p", {}, n.note))))));
  }

  // ---------- trust check: "Before you trust a pack" from the generator doc ----------
  // A confident picture can make a wrong idea feel true. Check a sample against the paper before relying on it.
  function trustBadge(pack, p) {
    const t = p.trust; if (!t) return el("a", { class: "small trustlink", href: `#/pack/${pack.id}/reference/check` }, "Not checked yet: verify the pack →");
    const n = trustItems(pack).length; const done = Object.values(t.items || {}).filter((x) => x.status).length;
    const probs = Object.values(t.items || {}).filter((x) => x.status === "problem").length;
    return el("a", { class: "small trustlink" + (done === n && !probs ? " ok" : ""), href: `#/pack/${pack.id}/reference/check` },
      probs ? `⚠ ${plural(probs, "problem")} found in the pack` : done === n ? "✓ Spot-checked against the paper" : `Trust check: ${done} of ${n} done`);
  }
  function trustItems(pack) {
    const claims = ((pack.files["claims.json"] || {}).claims || []).slice();
    const rank = { low: 0, medium: 1, high: 2 };
    claims.sort((a, b) => rank[a.confidence] - rank[b.confidence] || /\d/.test(b.paraphrase) - /\d/.test(a.paraphrase));
    const cards = cardsOf(pack).filter((c) => /\d/.test(c.back)).concat(cardsOf(pack)).filter((c, i, a) => a.indexOf(c) === i);
    const chart = visualsOf(pack).find((v) => ["result_chart", "ablation_chart"].includes(v.type));
    const items = [
      ...claims.slice(0, 3).map((c) => ({ key: "claim:" + c.id, file: "claims.json", id: c.id, kind: "Claim", text: c.paraphrase, where: c.evidence, extra: c.confidence !== "high" ? `${c.confidence} confidence` : null })),
      ...cards.slice(0, 2).map((c) => ({ key: "card:" + c.id, file: "cards.json", id: c.id, kind: "Card", text: `${c.front} → ${c.back}`, where: c.source })),
    ];
    if (chart) items.push({ key: "chart:" + chart.id, file: "visuals.json", id: chart.id, kind: "Chart", text: `${chart.title}: compare every bar or point with the table`, where: chart.source, visual: chart });
    return items;
  }
  function refCheck(pack, prog) {
    prog.trust = prog.trust || { items: {}, links: {}, status: "" };
    const t = prog.trust; const items = trustItems(pack);
    const links = ((pack.files["refs.json"] || {}).refs || []).filter((r) => r.link);
    const m = pack.files["manifest.json"];
    const doneCount = () => items.filter((i) => t.items[i.key] && t.items[i.key].status).length;
    const bar = el("div", {}); const summary = el("div", {});
    const refresh = async () => {
      await saveProgress(prog);
      bar.replaceChildren(progressBar(doneCount(), items.length, "Trust check progress"), el("span", { class: "small" }, `${doneCount()} of ${items.length} checked`));
      const problems = items.filter((i) => t.items[i.key] && t.items[i.key].status === "problem");
      summary.replaceChildren(...(problems.length ? [el("div", { class: "panel problems" }, el("h3", {}, `${plural(problems.length, "problem")} found`),
        el("p", { class: "small muted" }, "Send these to the chat that made the pack (fix mode). Then paste its reply into Apply fixes."),
        el("div", { class: "row" },
          el("button", { class: "btn", onclick: () => copyText(fixRequest(pack, problems, t)).then(() => toast("Fix request copied")) }, "Copy fix request"),
          el("button", { class: "btn secondary", onclick: () => applyFixesUI(pack) }, "Apply fixes…")))] : []));
      if (doneCount() === items.length && !problems.length && t.status.trim())
        award(`${pack.id}:trust`, 80, "Checked the pack against the paper", pack.id, ["fact-checker"]).then((xp) => { if (xp) celebrate("Pack verified"); });
    };
    const row = (it) => {
      const state = t.items[it.key] || {};
      const note = el("input", { type: "search", placeholder: "What's wrong? (e.g. Table 2 says 41.0, not 41.8)", value: state.note || "", "aria-label": "Describe the problem" });
      note.addEventListener("input", () => { t.items[it.key] = { ...(t.items[it.key] || {}), note: note.value }; refresh(); });
      const set = (status) => { t.items[it.key] = { status, note: note.value }; refreshRow(); refresh(); };
      const li = el("li", {});
      const refreshRow = () => {
        const st = (t.items[it.key] || {}).status;
        li.className = st || "";
        li.replaceChildren(
          el("div", { class: "row spread" }, el("span", { class: "badge" }, `${it.kind} ${it.id}`), el("span", { class: "small muted" }, "Open the paper at " + loc(it.where))),
          el("p", {}, it.text), it.extra ? el("p", { class: "small" }, el("span", { class: "badge medium" }, it.extra)) : null,
          it.visual ? el("details", {}, el("summary", {}, "Show the chart"), visualFigure(pack, it.visual)) : null,
          el("div", { class: "row" },
            el("button", { class: "btn " + (st === "ok" ? "" : "secondary"), onclick: () => set("ok") }, "✓ Matches the paper"),
            el("button", { class: "btn " + (st === "problem" ? "danger-fill" : "secondary"), onclick: () => set("problem") }, "✗ Problem")),
          st === "problem" ? note : null);
      };
      refreshRow(); return li;
    };
    const linkRows = links.map((r) => el("li", { class: "row spread" },
      el("span", {}, el("strong", {}, r.label + " "), el("a", { href: r.link, target: "_blank", rel: "noopener noreferrer" }, r.title)),
      el("label", { class: "small" }, el("input", { type: "checkbox", checked: t.links[r.ref_id] ? true : null, onchange: (e) => { t.links[r.ref_id] = e.target.checked; refresh(); } }), " opens the right paper")));
    const status = el("input", { type: "search", value: t.status || "", placeholder: m.source.startsWith("arxiv") ? "e.g. NeurIPS 2017; or still a preprint" : "Where was it published?", "aria-label": "Publication status" });
    status.addEventListener("input", () => { t.status = status.value; refresh(); });
    refresh();
    return el("div", {},
      el("div", { class: "panel" }, el("h2", {}, "Check the pack before you trust it"),
        el("p", { class: "muted" }, "The pack was written by an AI from the paper. It can misread a table, and a confident picture makes a wrong idea feel true. Check this sample against the paper: if it holds, the rest likely does too."),
        bar),
      summary,
      el("div", { class: "panel" }, el("h3", {}, "Spot-check against the paper"), el("ol", { class: "trust" }, items.map(row))),
      el("div", { class: "panel" }, el("h3", {}, "Is it published?"),
        el("p", { class: "small muted" }, m.source.startsWith("arxiv") ? "arXiv papers are preprints. Look up whether this one was published, and where, before treating its results as settled." : "Note where this paper was published."),
        status),
      links.length ? el("details", { class: "panel" }, el("summary", {}, `Reference links (${links.length}): start unverified`),
        el("p", { class: "small muted" }, "Open each link you plan to use and tick it if it's the right paper."), el("ul", { class: "plain refs" }, linkRows)) : null);
  }
  function fixRequest(pack, problems, t) {
    return ["Fix mode. While checking the pack against the paper I found these problems:", "",
      ...problems.map((i) => `- ${i.file} ${i.id} (${loc(i.where)}): ${(t.items[i.key].note || "does not match the paper").trim()}`), "",
      "Please return only the corrected files, with the same IDs."].join("\n");
  }

  // ---------- fix mode: apply Claude's corrected files to the pack in this app ----------
  async function packForValidation(pack) {
    const assets = {};
    for (const [path, blob] of Object.entries(pack.blobs || {}))
      assets[path] = { mime: blob.type, text: path.endsWith(".svg") || path.endsWith(".html") ? await blob.text() : undefined };
    return { files: pack.files, assets };
  }
  function applyFixesUI(pack) {
    const ta = el("textarea", { class: "fixpaste", placeholder: "Paste Claude's whole fix-mode reply here, including the ``` code blocks…", "aria-label": "Claude's reply" });
    const out = el("div");
    const run = el("button", { class: "btn", onclick: async () => {
      const { files, problems } = window.PackFixes.parseFixes(ta.value);
      if (!files.length) { out.replaceChildren(el("p", { class: "note" }, problems.join(" "))); return; }
      const next = { ...pack, files: { ...pack.files }, blobs: { ...pack.blobs } };
      for (const f of files) {
        if (f.path.endsWith(".json")) next.files[f.path] = JSON.parse(f.content);
        else next.blobs[f.path] = new Blob([f.content], { type: "image/svg+xml" });
      }
      const issues = V.validate(await packForValidation(next));
      const errors = issues.filter((i) => i.level === "error");
      const list = el("ul", {}, files.map((f) => el("li", {}, (pack.files[f.path] || (pack.blobs || {})[f.path] ? "Replace " : "Add ") + f.path)));
      out.replaceChildren(
        el("h3", {}, `${plural(files.length, "file")} ready`), list,
        problems.length ? el("p", { class: "small note" }, problems.join(" ")) : null,
        errors.length ? el("p", { class: "note" }, `After these fixes the pack would still have ${plural(errors.length, "error")}. Copy them back to the chat.`) : el("p", { class: "small muted" }, "The pack checks out with these fixes."),
        errors.length ? issueGroups(issues)[0] : null,
        el("div", { class: "row actions" },
          errors.length ? el("button", { class: "btn secondary", onclick: () => copyText(V.formatIssues(issues)).then(() => toast("Issues copied")) }, "Copy remaining issues") : null,
          el("button", { class: errors.length ? "btn secondary" : "btn", onclick: async () => {
            next.history = [...(pack.history || []), { at: Date.now(), files: pack.files }].slice(-5); // keep the last versions to undo
            next.warnings = issues.filter((i) => i.level === "warning");
            await put("packs", next); modal.close(); toast(`Applied ${plural(files.length, "fix", "fixes")}`);
            award(`${pack.id}:fix:${Date.now()}`, 20, "Applied fixes to a pack", pack.id); route();
          } }, errors.length ? "Apply anyway" : "Apply fixes")));
    } }, "Check these fixes");
    showModal(el("h2", {}, "Apply fixes from chat"),
      el("p", { class: "small muted" }, "When the app or the trust check finds problems, paste them into the chat that made the pack. Claude replies with corrected files; paste that reply here. Nothing changes until you press Apply. The app's copy is updated; to update the pack folder itself use the pack tool's apply command."),
      ta, el("div", { class: "row actions" }, run), out);
  }

  // ---------- profile: level, streak, badges, XP log ----------
  async function renderProfile() {
    const p = await getProfile(); const li = levelInfo(p.xp);
    const packs = await getAll("packs");
    main.replaceChildren(
      el("a", { class: "back small", href: "#/" }, "← Library"),
      el("h1", {}, "Your progress"),
      el("section", { class: "panel goal" },
        el("div", { class: "row spread" }, el("div", {}, el("div", { class: "big-num" }, `Level ${li.level}`), el("div", { class: "muted" }, li.name)),
          el("div", { class: "small muted" }, li.next ? `${p.xp} / ${li.next} XP` : `${p.xp} XP`)),
        progressBar(li.into, li.span, "Progress to next level"),
        el("div", { class: "goalrow" },
          el("div", {}, el("div", { class: "big-num" }, `🔥 ${streak(p)}`), el("div", { class: "small muted" }, "day streak")),
          el("div", {}, el("div", { class: "big-num" }, `${papersThisWeek(p)}/${WEEKLY_GOAL}`), el("div", { class: "small muted" }, "papers this week")),
          el("div", {}, el("div", { class: "big-num" }, String(packs.length)), el("div", { class: "small muted" }, "papers in library")))),
      el("h2", {}, `Badges (${Object.keys(p.badges).length} of ${BADGES.length})`),
      el("div", { class: "badges" }, BADGES.map(([id, name, how]) => el("div", { class: "badgecard" + (p.badges[id] ? " earned" : "") },
        el("div", { class: "badge-icon", "aria-hidden": "true" }, p.badges[id] ? "🏅" : "🔒"), el("strong", {}, name), el("span", { class: "small muted" }, how)))),
      el("h2", {}, "Recent XP"),
      p.log.length ? el("ul", { class: "plain xplog" }, p.log.slice(0, 20).map((x) => el("li", {}, el("span", { class: "badge high" }, `+${x.xp}`), " ", x.why,
        el("span", { class: "small muted" }, " · " + new Date(x.t).toLocaleDateString())))) : el("p", { class: "muted" }, "Nothing yet. Start a pass to earn XP."),
      el("p", { class: "small muted" }, "How XP works: 10 per part of the paper you tick off, 20 per answered question, 5 per summary step, 10 per remembered card, 50 per boss win, 100 per cleared pass, 150 for the debrief."));
    document.title = "Your progress · Paper Study";
    setAppBar("Your progress", "#/");
  }

  // ---------- router ----------
  async function route() {
    const parts = location.hash.replace(/^#\/?/, "").split("/");
    try {
      if (parts[0] === "pack" && parts[1]) await renderPack(decodeURIComponent(parts[1]), parts[2] || null, parts[3], parts[4]);
      else if (parts[0] === "me") { cleanup.forEach((f) => f()); cleanup = []; await renderProfile(); }
      else { cleanup.forEach((f) => f()); cleanup = []; document.title = "Paper Study"; await renderLibrary(); }
    } catch (e) {
      main.replaceChildren(el("div", { class: "panel" }, el("h2", {}, "Something went wrong"), el("p", {}, String(e && e.message || e))));
      console.error(e);
    }
  }
  window.addEventListener("hashchange", route);
  renderHud();
  route();
})();
