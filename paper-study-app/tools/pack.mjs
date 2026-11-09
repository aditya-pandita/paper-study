#!/usr/bin/env node
// Study pack command-line tool.
//   node tools/pack.mjs new      <arXiv link or id> [--depth scan|use|own] [--out <folder>]
//   node tools/pack.mjs validate <pack-folder | pack.json> [--strict]
//   node tools/pack.mjs apply    <pack-folder> <reply.txt | -> [--dry-run]
//   node tools/pack.mjs bundle   <pack-folder> [-o out.pack.json]
//   node tools/pack.mjs zip      <pack-folder> [-o name.zip]
// new:      starts a pack from arXiv: downloads the latest PDF, records version and SHA-256,
//           drafts manifest.json and the section map, and writes the message to send to Claude.
// validate: --strict treats "planned visual not drawn yet" as an error (use it on a finished pack).
// apply:    fix mode. Reads Claude's reply (code blocks labelled with file paths), backs up the
//           files it replaces into <pack>.backups/<time>/, writes the fixes, then validates.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, relative, basename, resolve, extname, dirname } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const { validate, formatIssues, DATA_FILES } = require("../lib/validate.js");
const { parseFixes } = require("../lib/fixes.js");

const MIME = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".html": "text/html", ".mp4": "video/mp4" };
const TEXT_TYPES = new Set([".svg", ".html"]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

export function loadFolder(dir) {
  const pack = { files: {}, assets: {}, parseErrors: [] };
  for (const p of walk(dir)) {
    const rel = relative(dir, p).split("\\").join("/");
    const ext = extname(p).toLowerCase();
    if (ext === ".json" && !rel.includes("/")) {
      if (!DATA_FILES.includes(rel)) continue;
      try { pack.files[rel] = JSON.parse(readFileSync(p, "utf8")); }
      catch (e) { pack.parseErrors.push({ level: "error", file: rel, id: null, message: "invalid JSON: " + e.message }); }
    } else if (MIME[ext]) {
      const buf = readFileSync(p);
      pack.assets[rel] = TEXT_TYPES.has(ext) ? { mime: MIME[ext], text: buf.toString("utf8") } : { mime: MIME[ext], base64: buf.toString("base64") };
    }
  }
  return pack;
}

function loadAny(target) {
  if (statSync(target).isDirectory()) return loadFolder(target);
  const obj = JSON.parse(readFileSync(target, "utf8"));
  if (obj.pack_format === "study-pack-bundle/1") return { files: obj.files, assets: obj.assets, parseErrors: [] };
  throw new Error("Not a pack folder or a study-pack bundle: " + target);
}

function report(target, opts) {
  const pack = loadAny(target);
  const issues = [...pack.parseErrors, ...validate(pack, opts)];
  const errors = issues.filter((i) => i.level === "error").length;
  console.log(formatIssues(issues, `Study pack issues for ${basename(resolve(target))}:`));
  console.log(`\n${errors} error(s), ${issues.length - errors} warning(s). ${errors ? "The app will reject this pack." : "The app will accept this pack."}`);
  return errors;
}

function usage(code) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 14).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(code);
}

const [cmd, target, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };
if (!cmd) usage(0);
if (!target) usage(1);
if (cmd !== "new" && !existsSync(target)) { console.error(`Not found: ${target}`); process.exit(1); }

if (cmd === "validate") {
  process.exit(report(target, { strictFiles: flag("--strict") }) ? 1 : 0);
} else if (cmd === "bundle") {
  const pack = loadFolder(target);
  const errors = [...pack.parseErrors, ...validate(pack)].filter((i) => i.level === "error");
  if (errors.length) { console.error(formatIssues(errors, "Fix these before bundling:")); process.exit(1); }
  const out = opt("-o") || resolve(target) + ".pack.json"; // next to the folder, so it never ends up inside it
  writeFileSync(out, JSON.stringify({ pack_format: "study-pack-bundle/1", schema_version: 1, files: pack.files, assets: pack.assets }));
  console.log(`Wrote ${out} (${Math.round(statSync(out).size / 1024)} KB, ${Object.keys(pack.files).length} data files, ${Object.keys(pack.assets).length} assets).`);
} else if (cmd === "zip") {
  const dir = resolve(target);
  const out = resolve(opt("-o") || dir + ".zip");
  if (existsSync(out)) execFileSync("rm", [out]);
  execFileSync("zip", ["-rq", out, basename(dir), "-x", "*.DS_Store"], { cwd: resolve(dir, "..") });
  console.log(`Wrote ${out} (${Math.round(statSync(out).size / 1024)} KB).`);
} else if (cmd === "apply") {
  const dir = resolve(target);
  const src = rest.find((r) => !r.startsWith("--"));
  if (!src) { console.error("Give the file holding Claude's reply, or - to read it from stdin."); process.exit(1); }
  const text = src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  const { files, problems } = parseFixes(text);
  problems.forEach((p) => console.log("! " + p));
  if (!files.length) { console.log("Nothing to apply."); process.exit(1); }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backup = join(dirname(dir), basename(dir) + ".backups", stamp);
  for (const f of files) {
    const dest = join(dir, f.path);
    const exists = existsSync(dest);
    console.log(`${flag("--dry-run") ? "would " : ""}${exists ? "replace" : "add"} ${f.path}`);
    if (flag("--dry-run")) continue;
    if (exists) { mkdirSync(dirname(join(backup, f.path)), { recursive: true }); copyFileSync(dest, join(backup, f.path)); }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.content);
  }
  if (!flag("--dry-run")) console.log(`Old versions saved in ${backup}\n`);
  process.exit(report(dir, {}) ? 1 : 0);
} else if (cmd === "new") {
  await startPack(target);
} else usage(1);

// ---------- new: start a pack from an arXiv paper ----------
async function startPack(input) {
  const idm = String(input).match(/(\d{4}\.\d{4,5})(v\d+)?/);
  if (!idm) { console.error("Give an arXiv link or id, e.g. https://arxiv.org/abs/1706.03762"); process.exit(1); }
  for (const tool of ["pdftotext", "pdfinfo"]) {
    try { execFileSync("which", [tool], { stdio: "ignore" }); }
    catch { console.error(`Needs ${tool} (poppler). On a Mac: brew install poppler`); process.exit(1); }
  }
  const id = idm[1];
  console.log(`Looking up arXiv ${id}…`);
  const xml = await (await fetch(`https://export.arxiv.org/api/query?id_list=${id}`)).text();
  const entry = xml.split("<entry>")[1];
  if (!entry) { console.error("arXiv has no paper with that id."); process.exit(1); }
  const pick = (tag) => ((entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || "").replace(/\s+/g, " ").trim();
  const version = (pick("id").match(/v(\d+)$/) || [, "1"])[1];
  const title = pick("title");
  const authors = [...entry.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1].trim());
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 6).join("-");
  const dir = resolve(opt("--out") || `${slug}-pack`);
  const srcDir = dir + ".source"; // the PDF stays outside the pack, so sharing a pack never shares the paper
  if (existsSync(join(dir, "manifest.json"))) { console.error(`${dir} already has a manifest.json; not overwriting.`); process.exit(1); }
  mkdirSync(dir, { recursive: true }); mkdirSync(srcDir, { recursive: true });

  console.log(`Downloading ${id}v${version}: ${title}`);
  const pdfRes = await fetch(`https://arxiv.org/pdf/${id}v${version}`);
  if (!pdfRes.ok) { console.error(`Download failed: HTTP ${pdfRes.status}`); process.exit(1); }
  const pdf = Buffer.from(await pdfRes.arrayBuffer());
  if (pdf.subarray(0, 5).toString() !== "%PDF-") { console.error("arXiv did not return a PDF."); process.exit(1); }
  const pdfPath = join(srcDir, "paper.pdf"); writeFileSync(pdfPath, pdf);
  const sha = createHash("sha256").update(pdf).digest("hex");
  const pages = Number((execFileSync("pdfinfo", [pdfPath]).toString().match(/Pages:\s+(\d+)/) || [, 0])[1]);
  execFileSync("pdftotext", ["-layout", pdfPath, join(srcDir, "paper.txt")]);

  // Section and figure detection from each page's text: a draft for Claude to correct.
  // Headings are short lines, optionally numbered ("3", "A"), sometimes in small caps ("I NTRODUCTION").
  const KEYWORDS = [["abstract", /^abstract$/], ["intro", /^introduction\b/], ["related", /^(related work|background|prior work|literature)/],
    ["experiments", /^(experiments?|experimental|results?|evaluation|empirical|training)\b/], ["conclusion", /^(conclusions?|discussion|future work|summary)\b/],
    ["references", /^(references|bibliography)$/], ["methods", /^(methods?|model|approach|architecture|our |proposed|framework|algorithm)/]];
  const heading = (raw) => {
    const line = raw.replace(/\b([A-Z]) (?=[A-Z]{2,})/g, "$1").replace(/\s+/g, " ").trim(); // rejoin small caps
    const m = line.match(/^(?:(\d+|[A-H])\.?\s+)?([A-Za-z][A-Za-z\-:, ]{2,70})$/);
    if (!m || m[2].split(" ").length > 9 || /[.;]$/.test(line)) return null;
    const isCaps = m[2] === m[2].toUpperCase();
    if (!m[1] && !isCaps && !/^(abstract|references|introduction|conclusions?)$/i.test(m[2])) return null; // unnumbered: only well-known names
    return { num: m[1] || null, text: m[2].toLowerCase().trim() };
  };
  const starts = [{ kind: "title", page: 1 }]; const figures = []; const seenFig = new Set();
  let afterRefs = false, sawExperiments = false;
  const add = (kind, page) => { if (kind && !starts.some((s) => s.kind === kind)) starts.push({ kind, page }); };
  for (let p = 1; p <= pages; p++) {
    const lines = execFileSync("pdftotext", ["-f", String(p), "-l", String(p), "-layout", pdfPath, "-"]).toString().split("\n");
    for (const raw of lines) {
      const fm = raw.match(/^\s*(Figure|Fig\.|Table)\s+(\d+)\s*[:.]/);
      if (fm) { const fid = (fm[1].startsWith("T") ? "tab" : "fig") + fm[2]; if (!seenFig.has(fid)) { seenFig.add(fid); figures.push({ id: fid, page: p, why_it_matters: "TODO" }); } continue; }
      const h = heading(raw); if (!h) continue;
      if (h.num && h.num.includes(".")) continue; // only top-level sections
      let kind = (KEYWORDS.find(([, re]) => re.test(h.text)) || [])[0];
      if (afterRefs && h.num && /^[A-H]$/.test(h.num)) kind = "appendix";
      if (!kind && h.num && /^\d+$/.test(h.num)) kind = sawExperiments ? null : "methods"; // a named method section, e.g. "3 Learning to align"
      if (kind === "references") afterRefs = true;
      if (kind === "experiments") sawExperiments = true;
      add(kind, p);
    }
  }
  starts.sort((a, b) => a.page - b.page);
  // each section runs until the page where the next one starts (sections often share a page)
  const sections = starts.map((s, i) => ({ kind: s.kind, pages: [s.page, starts[i + 1] ? Math.max(s.page, starts[i + 1].page) : pages] }));
  if (sections.length && sections[0].kind === "title") sections[0].pages = [1, 1];

  const depth = opt("--depth") || "use";
  const manifest = { schema_version: 1, paper_id: null, source: `arxiv:${id}v${version}`, title, authors, pdf_sha256: sha, page_count: pages,
    generated_on: new Date().toISOString().slice(0, 10), depth, depth_recommendation: { value: depth, reason: "TODO" },
    pack_notes: ["Started with pack.mjs new: section page ranges and figure list were detected automatically and need checking."] };
  const map = { schema_version: 1, one_sentence: "TODO", sections, figures, prerequisites: [], simple: { one_line: "TODO", claims: [], terms: [] } };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(dir, "map.json"), JSON.stringify(map, null, 2) + "\n");
  const message = [`Paper: https://arxiv.org/abs/${id}v${version} (PDF attached)`, `Depth: ${depth}`, "Topic I'm studying: ", "What I already know: ", "",
    "manifest.json and map.json are already drafted (attached). Keep manifest.json as is except depth_recommendation and pack_notes.",
    "In map.json, check the section page ranges and the figure list against the PDF, fill every TODO, and add \"visual\" and \"originals\" to figures once visuals exist.",
    "Follow the study pack prompt plus the lessons addendum (lessons.json with section and math tags)."].join("\n");
  writeFileSync(join(dir, "START-HERE.md"), `# ${title}\n\nStarted ${manifest.generated_on} from arXiv ${id}v${version} (${pages} pages).\nThe PDF and its text are in \`${basename(srcDir)}/\` (kept outside the pack).\n\n## Detected sections (check these)\n\n${sections.map((s) => `- ${s.kind}: pages ${s.pages[0]}-${s.pages[1]}`).join("\n")}\n\n## Detected figures and tables\n\n${figures.map((f) => `- ${f.id}: page ${f.page}`).join("\n") || "- none found"}\n\n## Next\n\n1. Start a chat with the study pack prompt and \`paper-study-app/PROMPT-ADDENDUM.md\`.\n2. Attach \`${basename(srcDir)}/paper.pdf\`, \`manifest.json\` and \`map.json\`, and send:\n\n\`\`\`text\n${message}\n\`\`\`\n\n3. Save Claude's replies with \`node paper-study-app/tools/pack.mjs apply ${basename(dir)} reply.txt\`.\n4. Check it with \`validate\`, then import the folder in Paper Study.\n`);
  console.log(`\nCreated ${dir}\n  manifest.json  (version v${version}, ${pages} pages, SHA-256 recorded)\n  map.json       (${sections.length} sections, ${figures.length} figures/tables detected: check them)\n  START-HERE.md  (the message to send to Claude)\nPDF and text:    ${srcDir}\n`);
  console.log("Send this to Claude with the PDF attached:\n\n" + message);
}
