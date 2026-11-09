# Addendum to the study pack generator prompt: lessons.json

> **Superseded.** The current prompt, with this addendum and the app's other additions merged in, is in [PAPER-TO-PACK.md](docs/PAPER-TO-PACK.md#5-the-prompt). This file is kept for reference.

The original prompt makes packs for testing yourself (questions, cards, visuals).
Paper Study is mainly for **reading the paper in an easier form**, so every new pack
should also contain `lessons.json`: the paper's content rebuilt step by step, at two
reading levels. Paste the block below into the prompt, right after section 6 (SIMPLE
LAYER), and add `lessons.json` to the folder list in section 2.

````text
================================================================
6b. LESSONS (the readable version of the paper)
================================================================
The app's main mode is Read. Build lessons.json in a new Round 1b, right after
Round 1, before the questions. Lessons TEACH the content; questions only test it.

- Rebuild the paper in order of understanding, not page order: the problem, the
  core idea, each component, how the parts fit, why it works, how it was trained,
  results, limits. Typically 6 to 12 lessons of 2 to 5 steps (use and own depth;
  scan: 3 to 5 lessons).
- One idea per step. Each step has:
    simple: 2 to 4 sentences, each under 12 words, no jargon. Same meaning as full.
    full:   3 to 7 sentences of plain English that a student could learn the
            method from. Keep the paper's symbols (d_k, Eq. 1) and define them.
- Paraphrase and explain. Never paste passages. Every step cites a location.
- Use only what the paper says. Your own analogies go in "analogy" (shown as
  "Analogy, not from the paper"). Your own critique is prefixed "Pack note:".
- Link a visual when it helps (any id from visuals.json, including ones planned
  but not drawn yet), but never an answer visual from answer_key.answer_visuals.
- "check" may point to one question id the step prepares you for. Never put the
  answer to a pass 1 prediction question in an EARLIER lesson than the results
  lesson unless the method requires it; say "Practice has a predict-first chart"
  instead of spoiling a predict_blank.
- "terms" lists glossary terms (exact glossary spelling) first used in the step.
- "section" names the part of the paper the step explains, using the map.json
  section kinds (abstract, intro, related, methods, math, experiments,
  conclusion, appendix). The app's Journey follows Andrew Ng's passes and shows,
  for each part it asks you to read, the steps tagged with that section. Include
  one step for the abstract and one for the conclusion (lesson l0 works well).
- "math": true on steps that are mainly equations or derivations. Pass 3 ("skip
  the maths") hides them; Pass 4 shows them.
- In map.json, give each figure a "visual": the id of its redraw or original
  figure in visuals.json, so the Journey can show it when you "look at the figures".

--- lessons.json ---
{"schema_version": 1, "lessons": [
  {"id": "l1", "title": "The problem the paper attacks",
   "why": "one line: why this lesson matters",
   "steps": [
     {"id": "l1.1", "heading": "...",
      "simple": "...", "full": "...",
      "analogy": null, "visual": null, "terms": ["Encoder"],
      "source": {"page": 2, "ref": "Sec. 1"}, "check": null,
      "section": "intro", "math": false}
   ]}
]}
IDs: lessons l1.., steps l<lesson>.<n>. Stable across rounds and fixes.
````

The app's validator (`node paper-study-app/tools/pack.mjs validate <pack>`) checks
lessons.json: ids, both reading levels, sources, visual ids, no answer visuals,
and check ids. A pack without lessons.json still imports; the Read tab is then hidden.
