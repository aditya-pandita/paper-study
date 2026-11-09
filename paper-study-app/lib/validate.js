/* Study pack validator. Shared by the browser app (window.PackValidator) and the
 * Node CLI (require). Input: { files: { "manifest.json": obj, ... },
 *                              assets: { "visuals/v01.svg": { mime, text? } } }
 * Output: array of { level: "error" | "warning", file, id, message }. */
(function (root) {
  "use strict";

  const DATA_FILES = ["manifest.json", "map.json", "claims.json", "questions.json", "cards.json",
    "derivations.json", "glossary.json", "answer_key.json", "refs.json", "visuals.json", "lessons.json"];
  const REQUIRED = {
    scan: ["manifest.json", "map.json", "claims.json", "questions.json", "cards.json", "answer_key.json", "refs.json", "visuals.json"],
    use: DATA_FILES.filter((f) => f !== "lessons.json"),
    own: DATA_FILES.filter((f) => f !== "lessons.json"),
  };
  const DEPTHS = ["scan", "use", "own"];
  const SECTION_KINDS = ["title", "abstract", "intro", "related", "methods", "math", "experiments", "conclusion", "references", "appendix"];
  const Q_TYPES = ["predict", "explain", "test"];
  const CARD_TYPES = ["why", "when", "what-if", "compare"];
  const CONFIDENCE = ["high", "medium", "low"];
  const ROLES = ["foundation", "baseline", "comparison", "method_used", "background"];
  const DECISIONS = ["scan", "use", "own", "skip"];
  const DEBRIEF_KEYS = ["goal", "approach", "use_yourself", "follow_refs"];
  const UNLOCKS = ["pass1", "triage_done", "pass2", "pass3", "pass4", "debrief", "deep"];
  const VISUAL_TYPES = ["overview", "pipeline", "result_chart", "figure_walkthrough", "concept", "comparison",
    "equation_decoder", "concept_map", "limits", "lineage", "dataflow", "ablation_chart", "algorithm_flow",
    "misreadings", "derivation_roadmap", "build_checklist", "cheat_sheet", "predict_blank", "analogy", "comic",
    "ladder", "card_visual", "explainer", "original_figure", "video"];
  const COUNTS = {
    claims: { scan: [3, 3], use: [8, 12], own: [12, 18] },
    cards: { scan: [5, 5], use: [12, 20], own: [12, 20] },
    derivations: { scan: [0, 0], use: [0, 2], own: [2, 5] },
  };

  function validate(pack, opts) {
    opts = opts || {};
    const issues = [];
    const add = (level, file, id, message) => issues.push({ level, file, id: id || null, message });
    const err = (f, id, m) => add("error", f, id, m);
    const warn = (f, id, m) => add("warning", f, id, m);
    const F = pack.files || {};
    const A = pack.assets || {};

    const manifest = F["manifest.json"];
    if (!manifest) { err("manifest.json", null, "missing manifest.json"); return issues; }
    const depth = DEPTHS.includes(manifest.depth) ? manifest.depth : "use";
    const pageCount = Number.isInteger(manifest.page_count) && manifest.page_count > 0 ? manifest.page_count : null;

    for (const f of REQUIRED[depth]) if (!F[f]) err(f, null, `missing ${f} (required at depth "${depth}")`);
    for (const [f, obj] of Object.entries(F)) {
      if (!obj || typeof obj !== "object") { err(f, null, "not a JSON object"); continue; }
      if (obj.schema_version !== 1) err(f, null, 'top-level "schema_version" must be 1');
    }

    const isStr = (v) => typeof v === "string" && v.trim().length > 0;
    const checkLoc = (f, id, loc, field) => {
      if (!loc || typeof loc !== "object") { err(f, id, `missing "${field}" location`); return; }
      if (!Number.isInteger(loc.page) || loc.page < 1) err(f, id, `"${field}.page" must be a page number >= 1`);
      else if (pageCount && loc.page > pageCount) err(f, id, `"${field}.page" ${loc.page} is beyond page_count ${pageCount}`);
      if (!isStr(loc.ref)) err(f, id, `"${field}.ref" must name a table, figure, equation or section`);
    };
    const checkIds = (f, list, prefix) => {
      const seen = new Set();
      for (const item of list) {
        const id = item && (item.id || item.ref_id);
        if (!isStr(id)) { err(f, null, "item without an id"); continue; }
        if (prefix && !prefix.test(id)) warn(f, id, `id "${id}" does not follow the naming scheme`);
        if (seen.has(id)) err(f, id, `duplicate id "${id}"`);
        seen.add(id);
      }
      return seen;
    };
    const checkCount = (f, kind, n) => {
      const [lo, hi] = COUNTS[kind][depth];
      if (n < lo || n > hi) warn(f, null, `${n} ${kind} at depth "${depth}"; expected ${lo === hi ? lo : lo + " to " + hi}`);
    };

    // manifest
    for (const k of ["source", "title", "generated_on"]) if (!isStr(manifest[k])) err("manifest.json", null, `"${k}" is required`);
    if (!Array.isArray(manifest.authors) || !manifest.authors.length) err("manifest.json", null, '"authors" must be a non-empty list');
    if (!DEPTHS.includes(manifest.depth)) err("manifest.json", null, '"depth" must be scan, use or own');
    if (!pageCount) err("manifest.json", null, '"page_count" must be a positive integer');
    if (manifest.pdf_sha256 !== null && manifest.pdf_sha256 !== undefined && !/^[0-9a-f]{64}$/.test(manifest.pdf_sha256))
      err("manifest.json", null, '"pdf_sha256" must be null or 64 lowercase hex characters');
    if (isStr(manifest.generated_on) && !/^\d{4}-\d{2}-\d{2}$/.test(manifest.generated_on)) err("manifest.json", null, '"generated_on" must be YYYY-MM-DD');
    if (!Array.isArray(manifest.pack_notes)) warn("manifest.json", null, '"pack_notes" should be a list');

    // claims
    const claims = (F["claims.json"] && F["claims.json"].claims) || [];
    const claimIds = checkIds("claims.json", claims, /^c\d+$/);
    checkCount("claims.json", "claims", claims.length);
    for (const c of claims) {
      if (!isStr(c.paraphrase)) err("claims.json", c.id, "empty paraphrase");
      checkLoc("claims.json", c.id, c.evidence, "evidence");
      if (!CONFIDENCE.includes(c.confidence)) err("claims.json", c.id, '"confidence" must be high, medium or low');
    }

    // map
    const map = F["map.json"];
    if (map) {
      if (!isStr(map.one_sentence)) err("map.json", null, '"one_sentence" is required');
      let lastStart = 0;
      for (const s of map.sections || []) {
        if (!SECTION_KINDS.includes(s.kind)) err("map.json", s.kind, `unknown section kind "${s.kind}"`);
        const p = s.pages;
        if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isInteger)) { err("map.json", s.kind, '"pages" must be [start, end]'); continue; }
        if (p[0] > p[1]) err("map.json", s.kind, `pages ${p[0]}-${p[1]} run backwards`);
        if (p[0] < 1 || (pageCount && p[1] > pageCount)) err("map.json", s.kind, `pages ${p[0]}-${p[1]} fall outside 1-${pageCount}`);
        if (p[0] < lastStart) err("map.json", s.kind, "sections are not in page order");
        lastStart = p[0];
      }
      for (const fig of map.figures || []) {
        if (!Number.isInteger(fig.page) || fig.page < 1 || (pageCount && fig.page > pageCount)) err("map.json", fig.id, "figure page out of range");
        if (!isStr(fig.why_it_matters)) warn("map.json", fig.id, 'figure has no "why_it_matters"');
      }
      for (const sc of (map.simple && map.simple.claims) || [])
        if (!claimIds.has(sc.claim_id)) err("map.json", sc.claim_id, `simple claim points at unknown claim "${sc.claim_id}"`);
    }

    // visuals (needed before cards and answer key)
    const visuals = (F["visuals.json"] && F["visuals.json"].visuals) || [];
    const visualIds = checkIds("visuals.json", visuals, null);
    const visualById = Object.fromEntries(visuals.map((v) => [v.id, v]));
    for (const v of visuals) {
      if (!VISUAL_TYPES.includes(v.type)) err("visuals.json", v.id, `unknown visual type "${v.type}"`);
      if (!UNLOCKS.includes(v.unlock)) err("visuals.json", v.id, `unknown unlock "${v.unlock}"`);
      checkLoc("visuals.json", v.id, v.source, "source");
      if (!isStr(v.purpose)) warn("visuals.json", v.id, 'missing "purpose"');
      if (!isStr(v.alt_text)) err("visuals.json", v.id, 'missing "alt_text"');
      else if (v.alt_text.trim().split(/\s+/).length > 40) warn("visuals.json", v.id, "alt_text is over 40 words");
      if (typeof v.analogy !== "boolean" || typeof v.simple !== "boolean") err("visuals.json", v.id, '"analogy" and "simple" must be true or false');
      if (v.type === "original_figure" && !isStr(v.credit)) err("visuals.json", v.id, 'original figures need a "credit" line');
      if (!isStr(v.file)) { err("visuals.json", v.id, 'missing "file"'); continue; }
      const asset = A[v.file];
      if (!asset) {
        (opts.strictFiles ? err : warn)("visuals.json", v.id, `file "${v.file}" not found (planned but not drawn yet?)`);
        continue;
      }
      checkAsset(v.file, asset, v, err, warn);
    }
    // stray SVGs not in the index still get the safety check
    for (const [path, asset] of Object.entries(A))
      if (!visuals.some((v) => v.file === path)) checkAsset(path, asset, null, err, warn);

    // questions
    const q = F["questions.json"];
    const questionIds = new Set();
    if (q) {
      const passes = ["pass1", "pass2", "pass3", "pass4"];
      const all = [];
      for (const p of passes) {
        const list = q[p];
        if (!Array.isArray(list)) { err("questions.json", p, `"${p}" must be a list`); continue; }
        const needed = depth === "scan" && p !== "pass1" ? [0, 0] : [2, 4];
        if (list.length < needed[0] || list.length > needed[1]) warn("questions.json", p, `${list.length} questions in ${p}; expected ${needed[0]} to ${needed[1]}`);
        for (const item of list) {
          all.push(item);
          if (!Q_TYPES.includes(item.type)) err("questions.json", item.id, '"type" must be predict, explain or test');
          if (!isStr(item.text)) err("questions.json", item.id, "empty question text");
          if ("answer" in item || "model_answer" in item) err("questions.json", item.id, "answers must live only in answer_key.json");
        }
      }
      checkIds("questions.json", all, /^q\d+$/).forEach((id) => questionIds.add(id));
      const keys = (q.debrief || []).map((d) => d.key);
      for (const k of DEBRIEF_KEYS) if (!keys.includes(k)) err("questions.json", "debrief", `debrief is missing key "${k}"`);
    }

    // cards
    const cards = (F["cards.json"] && F["cards.json"].cards) || [];
    checkIds("cards.json", cards, /^k\d+$/);
    checkCount("cards.json", "cards", cards.length);
    let withImage = 0;
    for (const c of cards) {
      if (!CARD_TYPES.includes(c.type)) err("cards.json", c.id, '"type" must be why, when, what-if or compare');
      if (!isStr(c.front) || !isStr(c.back)) err("cards.json", c.id, "front and back must both have text");
      checkLoc("cards.json", c.id, c.source, "source");
      for (const side of ["front_image", "back_image"]) {
        const ref = c[side];
        if (ref === null || ref === undefined) continue;
        if (side === "front_image") withImage++;
        if (visualIds.has(ref)) continue;
        if (typeof ref === "string" && ref.startsWith("visuals/")) {
          if (!A[ref]) (opts.strictFiles ? err : warn)("cards.json", c.id, `${side} "${ref}" not found (planned but not drawn yet?)`);
          continue;
        }
        err("cards.json", c.id, `${side} "${ref}" is neither a visual id nor a path under visuals/`);
      }
    }
    if (depth !== "scan" && cards.length && withImage < 6) warn("cards.json", null, `only ${withImage} cards have a front_image; expected at least 6`);

    // derivations
    const derivations = (F["derivations.json"] && F["derivations.json"].derivations) || [];
    checkIds("derivations.json", derivations, /^d\d+$/);
    if (F["derivations.json"]) checkCount("derivations.json", "derivations", derivations.length);
    for (const d of derivations) {
      checkLoc("derivations.json", d.id, d.where, "where");
      if (!isStr(d.hint_step)) err("derivations.json", d.id, 'missing "hint_step"');
    }

    // glossary
    for (const t of (F["glossary.json"] && F["glossary.json"].terms) || []) {
      if (!isStr(t.term) || !isStr(t.meaning)) err("glossary.json", t.term, "term and meaning are required");
      if (!Number.isInteger(t.first_page) || t.first_page < 1 || (pageCount && t.first_page > pageCount)) err("glossary.json", t.term, "first_page out of range");
    }

    // answer key
    const key = F["answer_key.json"];
    if (key) {
      if (key.locked_until !== "debrief") err("answer_key.json", null, '"locked_until" must be "debrief"');
      for (const k of DEBRIEF_KEYS) if (!key.debrief || key.debrief[k] === undefined) err("answer_key.json", "debrief", `missing debrief answer "${k}"`);
      for (const a of key.quiz || []) {
        if (!questionIds.has(a.question_id)) err("answer_key.json", a.question_id, `answer for unknown question "${a.question_id}"`);
        checkLoc("answer_key.json", a.question_id, a.where, "where");
      }
      const answered = new Set((key.quiz || []).map((a) => a.question_id));
      for (const id of questionIds) if (!answered.has(id)) warn("answer_key.json", id, `question ${id} has no model answer`);
      for (const n of key.claim_notes || []) if (!claimIds.has(n.claim_id)) err("answer_key.json", n.claim_id, `note for unknown claim "${n.claim_id}"`);
      for (const vid of key.answer_visuals || []) {
        const v = visualById[vid];
        if (!v) err("answer_key.json", vid, `answer visual "${vid}" is not in visuals.json`);
        else if (!["debrief", "deep"].includes(v.unlock)) err("visuals.json", vid, `answer visual unlocks at "${v.unlock}"; it must not unlock before the debrief`);
      }
    }

    // lessons: the readable, step-by-step version of the paper
    const lessonsFile = F["lessons.json"];
    if (!lessonsFile) warn("lessons.json", null, "no lessons.json: the app's Read mode will be empty");
    else {
      const lessons = lessonsFile.lessons || [];
      if (!lessons.length) err("lessons.json", null, '"lessons" must be a non-empty list');
      checkIds("lessons.json", lessons, /^l\d+$/);
      const answerVisuals = new Set((key && key.answer_visuals) || []);
      for (const l of lessons) {
        if (!isStr(l.title)) err("lessons.json", l.id, "lesson needs a title");
        const steps = l.steps || [];
        if (!steps.length) err("lessons.json", l.id, "lesson has no steps");
        checkIds("lessons.json", steps, /^l\d+\.\d+$/);
        for (const s of steps) {
          if (!isStr(s.heading)) err("lessons.json", s.id, "step needs a heading");
          if (!isStr(s.simple) || !isStr(s.full)) err("lessons.json", s.id, 'step needs both "simple" and "full" text');
          checkLoc("lessons.json", s.id, s.source, "source");
          if (s.visual) {
            if (!visualIds.has(s.visual)) err("lessons.json", s.id, `visual "${s.visual}" is not in visuals.json`);
            else if (answerVisuals.has(s.visual)) err("lessons.json", s.id, `visual "${s.visual}" is an answer visual; lessons must not show it`);
          }
          if (s.check && !questionIds.has(s.check)) err("lessons.json", s.id, `check "${s.check}" is not a question id`);
          if (s.analogy !== undefined && s.analogy !== null && !isStr(s.analogy)) err("lessons.json", s.id, '"analogy" must be text or null');
          if (s.section !== undefined && !SECTION_KINDS.includes(s.section)) err("lessons.json", s.id, `"section" must be one of the map's section kinds`);
          if (s.math !== undefined && typeof s.math !== "boolean") err("lessons.json", s.id, '"math" must be true or false');
        }
      }
    }

    if (lessonsFile && (lessonsFile.lessons || []).every((l) => (l.steps || []).every((s) => s.section === undefined)))
      warn("lessons.json", null, 'no step has a "section": the Journey cannot show the paper\'s content part by part');
    for (const f of (map && map.figures) || []) {
      if (f.visual && !visualIds.has(f.visual)) err("map.json", f.id, `figure points at visual "${f.visual}", which is not in visuals.json`);
      for (const o of f.originals || []) if (!visualIds.has(o)) err("map.json", f.id, `figure points at original "${o}", which is not in visuals.json`);
      if (f.spoiler !== undefined && typeof f.spoiler !== "boolean") err("map.json", f.id, '"spoiler" must be true or false');
      if (!f.visual && !(f.originals || []).length) warn("map.json", f.id, "figure has no picture: the Journey can only describe it in words");
    }

    // refs
    const refsFile = F["refs.json"];
    const refs = (refsFile && refsFile.refs) || [];
    checkIds("refs.json", refs, /^r\d+$/);
    let heavy = 0;
    for (const r of refs) {
      if (!ROLES.includes(r.role)) err("refs.json", r.ref_id, `unknown role "${r.role}"`);
      if (!DECISIONS.includes(r.suggested_decision)) err("refs.json", r.ref_id, `unknown decision "${r.suggested_decision}"`);
      if (["use", "own"].includes(r.suggested_decision)) heavy++;
      if (r.link_verified !== false && r.link_verified !== true) err("refs.json", r.ref_id, '"link_verified" must be true or false');
      if (r.link && !/^https:\/\//.test(r.link)) err("refs.json", r.ref_id, "links must be https URLs");
      if (r.why_it_matters) checkLoc("refs.json", r.ref_id, r.why_it_matters.where, "why_it_matters.where");
      if (!CONFIDENCE.includes(r.confidence)) err("refs.json", r.ref_id, '"confidence" must be high, medium or low');
    }
    if (heavy > 5) err("refs.json", null, `${heavy} references are marked use or own; the limit is 5`);
    if (refsFile && !Array.isArray(refsFile.unparsed)) warn("refs.json", null, '"unparsed" should be a list');

    return issues;
  }

  function checkAsset(path, asset, visual, err, warn) {
    const id = visual ? visual.id : path;
    if (path.endsWith(".svg")) {
      const s = asset.text || "";
      if (/<script/i.test(s)) err(path, id, "SVG contains <script>; rejected");
      if (/<image/i.test(s)) err(path, id, "SVG contains <image>; rejected");
      if (/<foreignObject/i.test(s)) err(path, id, "SVG contains <foreignObject>; rejected");
      if (/\son[a-z]+\s*=/i.test(s)) err(path, id, "SVG contains an event-handler attribute; rejected");
      if (/(?:xlink:)?href\s*=\s*["'](?!#)/i.test(s)) err(path, id, "SVG links to an outside resource; rejected");
      if (/@import|url\(\s*["']?(?!#)/i.test(s)) err(path, id, "SVG loads an outside resource; rejected");
      const vb = s.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
      const isCard = path.startsWith("visuals/cards/");
      if (!vb) warn(path, id, "SVG has no viewBox");
      else if (isCard ? !(+vb[1] === 400 && +vb[2] === 240) : !(+vb[1] === 800 && +vb[2] >= 300 && +vb[2] <= 1200))
        warn(path, id, `viewBox ${vb[1]}x${vb[2]} is outside the allowed size`);
      if (!/<svg[^>]*>\s*<title>[\s\S]*?<\/title>\s*<desc>/.test(s)) warn(path, id, "first two children should be <title> and <desc>");
      if (s.length > 16000) warn(path, id, `SVG is ${Math.round(s.length / 1024)} KB; aim for under 8 KB`);
    } else if (/\.mp4$/i.test(path)) {
      if (visual && visual.type !== "video") warn(path, id, "videos should have type \"video\"");
    } else if (/\.(png|jpe?g|webp)$/i.test(path)) {
      if (visual && visual.type !== "original_figure") warn(path, id, "raster images are only expected for original figures");
    } else if (path.endsWith(".html")) {
      const s = asset.text || "";
      if (/<script[^>]+src=/i.test(s) || /<link[^>]+href=["']https?:/i.test(s)) err(path, id, "explainer loads outside files; rejected");
    } else if (path.startsWith("visuals/")) {
      warn(path, id, "unexpected file type");
    }
  }

  function formatIssues(issues, title) {
    if (!issues.length) return "No issues found.";
    const lines = [title || "Study pack issues:"];
    for (const i of issues) lines.push(`- [${i.level}] ${i.file}${i.id ? " (" + i.id + ")" : ""}: ${i.message}`);
    return lines.join("\n");
  }

  const api = { validate, formatIssues, DATA_FILES, UNLOCKS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PackValidator = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
