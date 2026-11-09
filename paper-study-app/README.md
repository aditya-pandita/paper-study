# Paper Study

An app for studying research papers with the study packs made by the
"Paper study pack generator" prompt. It runs on Mac, Android and in a browser,
and keeps everything on the device (IndexedDB). No network calls.

All three share one set of screens (`index.html`, `app.js`, `style.css`,
`lib/validate.js`). The Mac and Android apps wrap them in a native window with
native file pickers, clipboard and PDF hashing.

## Mac app

```bash
./macos/build.sh
```

Builds `dist/Paper Study.app` with Swift Package Manager (Xcode not needed).
Drag it to Applications. File ▸ Import Pack Folder… is ⌘O; ⌘L goes to the library.
The app is signed ad hoc for this Mac only; on another Mac, right-click ▸ Open the
first time. Self-test: `PAPERSTUDY_SELFTEST=1 "dist/Paper Study.app/Contents/MacOS/PaperStudy"`.

## Android app

```bash
cd android && JAVA_HOME=/opt/homebrew/opt/openjdk@21 ./gradlew assembleRelease
```

The APK lands in `android/app/build/outputs/apk/release/` (a copy is in
`dist/PaperStudy-android.apk`). It is signed with the debug key, which is fine for
installing on your own phone (allow "install unknown apps"), not for the Play Store.
Import a pack by copying its folder to the phone (e.g. into Download/papers) and
choosing that folder; Android won't let apps pick the Download folder itself.
The app has no internet permission. Self-test:
`adb shell am start -n local.paperstudy.android/.MainActivity --ez selftest true`, then
`adb logcat -s PaperStudy`.

## Design: Laws of UX

Choices are tagged `[Law]` in `app.js` and `style.css`. In short: one Import entry
point and at most five tabs, locked ones hidden (Hick's Law); one filled primary
button per screen (Von Restorff); 44 px targets, a sticky Finish bar and a bottom tab
bar on phones (Fitts's Law, Jakob's Law); live "2 of 3 answered" counts and progress
bars (Goal-Gradient); each paper in the library says what's unfinished (Zeigarnik);
stages named for what you do, with time boxes (Mental Model, Parkinson's Law);
earlier answers one tap away (Working Memory); warnings grouped and folded
(Cognitive Load, Chunking); a parent folder or a BOM is accepted (Postel's Law);
autosave and instant toasts (Doherty Threshold); a clear end to each card session
and to the whole study (Peak-End Rule); Space / 1 / 2 keys in review (Flow).

## Run it in a browser

From the repository root:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Then open http://localhost:8765/paper-study-app/ and click **Import pack folder**
(pick the folder that contains `manifest.json`) or **Import pack.json** (a bundle
made by the tool below). Use Chrome, Edge, Arc or Safari; folder import needs one of them.

## What the app does

- **Journey** (Andrew Ng's method): Pass 1 skim → triage → Pass 2 outline → Pass 3 read
  (maths skipped) → Pass 4 master → his four debrief questions → re-derive and rebuild.
  Each pass is a checklist of what to read; every item opens that part of the paper in
  the app (the pack's explanation, the paper's own figures and tables, the redraws).
- **Summary**: the paper as short lessons, Simple or Full, plus a narrated overview video
  that opens after Pass 1.
- **Game layer**: XP, levels, streak, a weekly goal of 3 papers, badges, boss quizzes.
- **Links between papers**: references that already have a pack open it; others go on
  a reading list. Each paper shows what in your library it cites and what cites it.
- **Check the pack** (Reference ▸ Check the pack): the "before you trust a pack" list.
  Spot-check 3 claims, 2 cards and 1 chart against the paper, verify links and
  publication status. Problems become a fix request to paste into the chat.
- **Apply fixes from chat** (library ▸ More): paste Claude's fix-mode reply; the app
  shows what will change, re-checks the pack and applies it (keeping the old version).
- **Checks every pack on import** and rejects unsafe SVGs (scripts, `<image>`,
  `<foreignObject>`, event handlers, outside links).
- **Spaced card review** (Leitner boxes: 1, 3, 7, 14, 30, 60 days).
- Desktop uses the width (sidebar, reading pane); Android has its own phone design
  (app bar, bottom nav, bottom sheets, swipes, haptics, system Back).

## Pack tool (Node)

```bash
node paper-study-app/tools/pack.mjs new https://arxiv.org/abs/1409.0473
node paper-study-app/tools/pack.mjs validate attention-is-all-you-need-pack --strict
node paper-study-app/tools/pack.mjs apply attention-is-all-you-need-pack reply.txt
node paper-study-app/tools/pack.mjs bundle attention-is-all-you-need-pack
node paper-study-app/tools/pack.mjs zip attention-is-all-you-need-pack
python3 paper-study-app/tools/make_video.py attention-is-all-you-need-pack
```

See [docs/PAPER-TO-PACK.md](docs/PAPER-TO-PACK.md) for the complete guide: the full prompt, every file format, the checks, and importing.

- `new` starts a pack from an arXiv link: finds the latest version, downloads the PDF
  into `<name>-pack.source/` (kept outside the pack, so sharing a pack never shares the
  paper), records the SHA-256 and page count, drafts `manifest.json` and the section and
  figure map, and writes `START-HERE.md` with the message to send to Claude. Needs
  poppler (`brew install poppler`).
- `validate` prints the issues list the app shows; `--strict` for a finished pack.
- `apply` is fix mode: reads Claude's reply (code blocks labelled with file paths),
  backs up the files it replaces to `<pack>.backups/<time>/`, writes the fixes and
  validates. `--dry-run` shows what would change. Only pack data files and SVGs under
  `visuals/` can be written.
- `bundle` writes `<folder>.pack.json`; `zip` writes `<folder>.zip`.
- `make_video.py` narrates one scene per lesson with the macOS voice and the pack's
  pictures, writes `visuals/media/overview.mp4` and registers it. Needs ffmpeg.

The validator (`lib/validate.js`) and the fix parser (`lib/fixes.js`) are shared by the
app and the tool, so both always agree.

## Schema additions

On top of the generator prompt's schema, the app accepts visuals of type
`original_figure` (PNG, JPEG or WebP) with a required `credit` field, for figures
reproduced from the paper when its licence allows.
