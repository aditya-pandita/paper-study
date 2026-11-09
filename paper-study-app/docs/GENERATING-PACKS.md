# Generating study packs for Paper Study

A **study pack** is one paper turned into data the app reads:
- lessons at two reading levels
- questions for Andrew Ng's reading passes
- flashcards, glossary, claims and derivations
- references linking to other packs
- visuals, plus an optional narrated video

This guide goes from an arXiv link to a pack imported on the Mac and phone.

```
arXiv link ──► pack.mjs new ──► Claude, round by round ──► pack.mjs validate
                                       ▲                         │ issues?
                                       └──── fix mode ◄──────────┘
                                                                 │ ok
                     make_video.py (optional) ──► bundle / zip ──► import in the app
```

## What you need

| Tool | For | Install |
| --- | --- | --- |
| Node 18+ | `tools/pack.mjs` (start, check, fix, bundle) | `brew install node` |
| poppler | reading the PDF's pages and figures in `new` | `brew install poppler` |
| ffmpeg | the optional overview video | `brew install ffmpeg` |
| Claude | writing the pack | a Claude Project, or any chat |

## 1. Set up Claude once

1. Make a Claude Project, for example "Paper packs".
2. Paste [`pack-generator-prompt.md`](pack-generator-prompt.md) into the Project instructions. If you don't use a Project, paste it as the first message of each new chat.
3. Add the lessons block from [`../PROMPT-ADDENDUM.md`](../PROMPT-ADDENDUM.md). It goes right after section 6 (SIMPLE LAYER), and `lessons.json` joins the folder list in section 2. Without lessons, the app hides its main **Read** tab.

## 2. Start the pack

Run from the `Self Development` folder:

```bash
node paper-study-app/tools/pack.mjs new https://arxiv.org/abs/1706.03762 --depth use
```

**What `new` does**
- finds the latest arXiv version
- records its SHA-256 and page count
- drafts `manifest.json` and the section and figure map
- writes **`START-HERE.md`**, which holds the exact message to send Claude

**Where the paper goes:** `new` downloads the PDF into `<name>-pack.source/`, outside the pack. Sharing a pack never shares the paper, and the app never shows a PDF.

**Choosing a depth**

| Depth | Use it when | You get |
| --- | --- | --- |
| `scan` | deciding whether a paper is worth your time | map, 3 claims, pass 1 questions, 5 cards, 3 or 4 lessons, 3 core visuals |
| `use` | you need the idea or method (default) | every data file, 6 to 12 lessons, about 10 visuals |
| `own` | you want to master it | everything, plus derivations, about 18 visuals, a cheat sheet and an interactive explainer |

## 3. Let Claude build it in rounds

1. Open a new chat in the Project.
2. Send the message from `START-HERE.md` and attach the PDF from the `.source/` folder:

   ```text
   Paper: <arXiv link, or the attached PDF>
   Depth: use
   Topic I'm studying: <optional>
   What I already know: <optional>
   ```

3. Claude stops after each round. Reply **continue** to go on.

| Round | Files |
| --- | --- |
| 1 | `manifest.json`, `map.json`, `claims.json` |
| 1b | `lessons.json`, the readable version of the paper (from the addendum) |
| 2 | `questions.json`, `cards.json`, `derivations.json`, `glossary.json`, `answer_key.json` |
| 3 | `refs.json`: references with arXiv ids, so the app can link to packs you already have |
| 4 | `visuals.json`, the index of every visual |
| 5 and 6 | the SVG visuals, then the simple-layer and card visuals |

4. Save each file into the pack folder, keeping the same names, with SVGs under `visuals/`.

**Figures and tables.** When a lesson says "look at Table 1", the app shows that table. Use the paper's own figures where its licence allows: crop them into `visuals/original/` as PNGs, and register each with `"type": "original_figure"` and a `credit`. Otherwise Claude redraws a simplified SVG, and the app labels it as a redraw.

## 4. Check it

```bash
node paper-study-app/tools/pack.mjs validate attention-is-all-you-need-pack --strict
```

This prints the same issues list the app would show, because the app and the tool share `lib/validate.js`. `--strict` also fails on visuals that were planned but never drawn. Leave it off while a pack is still in progress.

## 5. Fix problems (fix mode)

1. Paste the issues list into the same chat. Claude replies with only the corrected files, as code blocks labelled with their paths.
2. Save that reply as `reply.txt`, or copy it to the clipboard, and apply it:

```bash
node paper-study-app/tools/pack.mjs apply attention-is-all-you-need-pack reply.txt --dry-run   # preview
node paper-study-app/tools/pack.mjs apply attention-is-all-you-need-pack reply.txt
pbpaste | node paper-study-app/tools/pack.mjs apply attention-is-all-you-need-pack -
```

**What `apply` does**
- backs up every file it replaces to `<pack>.backups/<time>/`
- writes the fixes, then validates again
- writes only pack data files and SVGs under `visuals/`

Repeat until `validate --strict` is clean.

## 6. Optional: the overview video

```bash
python3 paper-study-app/tools/make_video.py attention-is-all-you-need-pack
```

This makes one narrated scene per lesson, using the macOS voice and the pack's own pictures. It writes `visuals/media/overview.mp4` and registers it in `visuals.json`.

## 7. Package and import

```bash
node paper-study-app/tools/pack.mjs bundle attention-is-all-you-need-pack   # -> attention-is-all-you-need-pack.pack.json
node paper-study-app/tools/pack.mjs zip attention-is-all-you-need-pack      # -> attention-is-all-you-need-pack.zip
```

**Mac:** **⌘O** in Paper Study, then pick the pack folder or the `.pack.json`. Re-importing a pack with the same id updates it and keeps your progress.

**Android:** copy the `.pack.json` to the phone, for example into Downloads or through Syncthing. Then use **Import** in the app.

**Links between papers.** If a pack's `refs.json` cites a paper you already have a pack for (matched by arXiv id or title), the reference becomes a link that opens that pack.

## Pack folder layout

```
attention-is-all-you-need-pack/
  manifest.json      paper, version, depth, SHA-256
  map.json           sections and figures (each figure -> its visual id)
  lessons.json       the readable version: simple + full steps
  claims.json        what the paper claims, with locations
  questions.json     Ng-pass questions (no answers in here)
  answer_key.json    answers, kept apart so they can't leak
  cards.json         flashcards (Leitner boxes in the app)
  glossary.json      terms, defined on first use
  derivations.json   step-by-step maths (use / own)
  refs.json          references, with arXiv ids where known
  visuals.json       index of every visual and when it unlocks
  visuals/           SVG redraws, original/ figures, media/ video
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `new` fails on PDF pages | install poppler: `brew install poppler` |
| The app hides the Read tab | the pack has no `lessons.json`; add the addendum and run round 1b |
| "answer visual linked from a lesson" | the lesson points at a visual that gives away an answer; ask Claude to swap it |
| "planned visual not drawn yet" | finish rounds 5 and 6, or drop `--strict` while still working |
| An SVG is rejected | it contains a script, `<image>` or `<foreignObject>`; ask for a plain redraw |
| The app shows an old version | re-import; the pack id is the same, so it updates in place |
