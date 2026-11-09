# Paper Study

Read research papers in plain English, then master them with Andrew Ng's reading method.

Paper Study turns an arXiv paper into a **study pack**: short lessons at two reading levels, questions for each reading pass, flashcards, a glossary, references that link to other packs, and the paper's own figures and tables. The app walks you through the passes and adds XP, levels, badges and a streak along the way.

It runs on **macOS**, **Android** and in the **browser**. Everything stays on your device: no account, no server, no network calls.

## What's here

| Folder | Contents |
| --- | --- |
| [`paper-study-app/`](paper-study-app/) | The app: shared web screens, the macOS and Android shells, the pack tool and the video maker |
| [`paper-study-app/docs/PAPER-TO-PACK.md`](paper-study-app/docs/PAPER-TO-PACK.md) | **How to turn any paper into a pack**: the full prompt for Claude, every file format, the checks, importing |
| [`attention-is-all-you-need-pack/`](attention-is-all-you-need-pack/) | A complete sample pack for *Attention Is All You Need* (arXiv 1706.03762) |

## Try it in the browser

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Open http://localhost:8765/paper-study-app/, click **Import ▸ Pack folder…**, and pick `attention-is-all-you-need-pack/`.

## Build the apps

```bash
./paper-study-app/macos/build.sh                                   # macOS 14+, Apple Silicon and Intel; no Xcode needed
cd paper-study-app/android && ./gradlew assembleRelease            # Android 8+; needs JDK 21 and the Android SDK
```

The Mac app lands in `paper-study-app/dist/`. It's signed ad hoc, so the first time you open it, go to **System Settings ▸ Privacy & Security ▸ Open Anyway**. More detail is in [`paper-study-app/README.md`](paper-study-app/README.md).

## Make a pack for any paper

```bash
node paper-study-app/tools/pack.mjs new https://arxiv.org/abs/1706.03762 --depth use
```

Then follow [PAPER-TO-PACK.md](paper-study-app/docs/PAPER-TO-PACK.md): give Claude the prompt, work through the rounds, check the pack with `pack.mjs validate`, and import it.

## About the sample pack

The lessons, questions, cards and redrawn diagrams were written for this project. The original figures and tables in `attention-is-all-you-need-pack/visuals/original/` are from Vaswani et al., *Attention Is All You Need* (2017). They're reproduced with attribution under the permission the paper grants on page 1 for scholarly use, and each carries a credit line in `visuals.json`.
