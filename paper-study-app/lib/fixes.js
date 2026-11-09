/* Fix mode: reads the corrected files Claude sends back in chat (one fenced code block per
 * file, labelled with its path) so they can be applied to a pack. Shared by the app
 * (window.PackFixes) and the CLI (require). Only pack data files and SVGs under visuals/
 * are accepted; anything else is reported, never written. */
(function (root) {
  "use strict";
  const DATA = ["manifest", "map", "claims", "questions", "cards", "derivations", "glossary", "answer_key", "refs", "visuals", "lessons"];
  const ALLOWED = new RegExp(`^(?:(?:${DATA.join("|")})\\.json|visuals/[A-Za-z0-9_\\-/]+\\.svg)$`);

  // Pull a pack-relative path out of a fence label or the line just above a fence.
  function findPath(s) {
    const m = String(s || "").match(/([A-Za-z0-9_.\-/]+\.(?:json|svg))/);
    if (!m) return null;
    const parts = m[1].replace(/^\.\//, "").split("/");
    const at = parts.findIndex((x) => x === "visuals" || /\.json$/.test(x)); // drop any leading "<name>-pack/"
    return parts.slice(at >= 0 ? at : 0).join("/");
  }

  function parseFixes(text) {
    const files = [], problems = [];
    const re = /```([^\n`]*)\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(String(text)))) {
      const label = m[1].trim(), body = m[2];
      let path = findPath(label);
      if (!path) {
        const before = String(text).slice(0, m.index).split("\n").map((l) => l.replace(/[*_`#>]/g, "").trim()).filter(Boolean);
        path = findPath(before[before.length - 1]);
      }
      if (!path) { problems.push(`A code block has no file name (starts "${body.trim().slice(0, 40)}…"); skipped.`); continue; }
      if (path.includes("..") || !ALLOWED.test(path)) { problems.push(`"${path}" is not a pack file this tool may change; skipped.`); continue; }
      const content = body.replace(/\s+$/, "") + "\n";
      if (path.endsWith(".json")) {
        try { JSON.parse(content); } catch (e) { problems.push(`${path} is not valid JSON (${e.message}); skipped.`); continue; }
      } else if (!/^\s*<svg[\s>]/.test(content)) { problems.push(`${path} does not start with <svg>; skipped.`); continue; }
      const i = files.findIndex((f) => f.path === path);
      if (i >= 0) files[i] = { path, content }; else files.push({ path, content }); // last version wins
    }
    if (!files.length && !problems.length) problems.push("No code blocks found. Paste Claude's whole reply, including the ``` fences.");
    return { files, problems };
  }

  const api = { parseFixes };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PackFixes = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
