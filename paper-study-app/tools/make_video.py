#!/usr/bin/env python3
"""Make a narrated overview video for a study pack (macOS).

    python3 paper-study-app/tools/make_video.py <pack-folder> [--voice Samantha] [--full]

Builds one scene per lesson from lessons.json (the first step's Simple text, or Full with --full),
shows the step's picture (the pack's redraws or the paper's own figures), narrates it with the
macOS `say` voice and stitches the scenes with ffmpeg. Writes <pack>/visuals/media/overview.mp4
and registers it in visuals.json as type "video" (it opens in the app after Pass 1, so it never
spoils the predictions). Needs: macOS (say, qlmanage), ffmpeg, Pillow.
"""
import json, os, shutil, subprocess, sys, tempfile, textwrap

from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
INK, MUTED, TEAL, BG, BAND = (44, 44, 42), (107, 106, 100), (15, 110, 86), (250, 249, 245), (241, 239, 232)
FONT = "/System/Library/Fonts/Helvetica.ttc"


def font(size, bold=False):
    try:
        return ImageFont.truetype(FONT, size, index=1 if bold else 0)
    except OSError:
        return ImageFont.load_default()


def need(tool):
    if not shutil.which(tool):
        sys.exit(f"Needs {tool}. " + ("brew install ffmpeg" if tool == "ffmpeg" else "This tool runs on macOS."))


def raster(pack, rel, tmp):
    """PNG for a pack picture: SVGs go through Quick Look, then the white margin is trimmed."""
    path = os.path.join(pack, rel)
    if not os.path.exists(path):
        return None
    if rel.endswith(".svg"):
        subprocess.run(["qlmanage", "-t", "-s", "1600", "-o", tmp, path], capture_output=True)
        path = os.path.join(tmp, os.path.basename(rel) + ".png")
        if not os.path.exists(path):
            return None
    im = Image.open(path).convert("RGB")
    box = Image.eval(im.convert("L"), lambda v: 255 if v < 245 else 0).getbbox()
    return im.crop(box) if box else im


def slide(title, eyebrow, text, picture, credit):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 92], fill=BAND)
    d.text((48, 18), eyebrow.upper(), font=font(20, True), fill=TEAL)
    d.text((48, 44), title, font=font(34, True), fill=INK)
    text_top = 120
    if picture is not None:
        box_w, box_h = W - 96, 360
        pic = picture.copy()
        pic.thumbnail((box_w, box_h), Image.LANCZOS)
        x = (W - pic.width) // 2
        d.rounded_rectangle([x - 12, 110, x + pic.width + 12, 110 + pic.height + 24], 14, fill=(255, 255, 255), outline=(227, 224, 214))
        im.paste(pic, (x, 122))
        text_top = 122 + pic.height + 36
    size = 30 if picture is not None else 40
    lines = textwrap.wrap(text, width=70 if picture is not None else 52)
    max_lines = max(2, (H - 60 - text_top) // (size + 12))
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = lines[-1].rstrip(".,; ") + "…"
    if picture is None:  # text-only scene: centre the words in the space below the band
        text_top = 92 + max(28, (H - 92 - 60 - len(lines) * (size + 12)) // 2)
        d.rectangle([48, text_top - 4, 54, text_top + len(lines) * (size + 12) - 12], fill=TEAL)
    for i, line in enumerate(lines):
        d.text((72 if picture is None else 64, text_top + i * (size + 12)), line, font=font(size), fill=INK)
    d.text((48, H - 40), credit, font=font(18), fill=MUTED)
    return im


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    pack = os.path.abspath(args[0])
    voice = args[args.index("--voice") + 1] if "--voice" in args else "Samantha"
    level = "full" if "--full" in args else "simple"
    for tool in ("say", "qlmanage", "ffmpeg"):
        need(tool)
    manifest = json.load(open(os.path.join(pack, "manifest.json")))
    lessons = json.load(open(os.path.join(pack, "lessons.json")))["lessons"]
    vpath = os.path.join(pack, "visuals.json")
    visuals = json.load(open(vpath))
    by_id = {v["id"]: v for v in visuals["visuals"]}
    answer = set(json.load(open(os.path.join(pack, "answer_key.json"))).get("answer_visuals", []))

    scenes = [{"eyebrow": "Paper overview", "title": manifest["title"][:60], "picture": None,
               "say": f"A short overview of the paper: {manifest['title']}. Each part below comes from the study pack; check details against the paper.",
               "text": f"{', '.join(manifest['authors'][:3])}{' et al.' if len(manifest['authors']) > 3 else ''} · {manifest['source']}"}]
    for i, lesson in enumerate(lessons):
        step = lesson["steps"][0]
        pic_id = next((s["visual"] for s in lesson["steps"] if s.get("visual") and s["visual"] not in answer), None)
        v = by_id.get(pic_id)
        if v and v.get("unlock") in ("debrief", "deep"):
            v = None
        scenes.append({"eyebrow": f"Lesson {i + 1} of {len(lessons)}", "title": lesson["title"][:60], "visual": v,
                       "say": f"{lesson['title']}. {step[level]}", "text": step[level],
                       "credit": f"From the paper: p. {step['source']['page']}, {step['source']['ref']}" + ("  ·  " + v["credit"][:70] + "…" if v and v.get("credit") else "")})
    scenes.append({"eyebrow": "Next", "title": "Now read it properly", "picture": None,
                   "say": "That's the overview. Now go back to the Journey and work through the four passes.",
                   "text": "Open the Journey: skim, outline, read, master. Then answer the four debrief questions."})

    tmp = tempfile.mkdtemp(prefix="packvideo-")
    parts = []
    for n, sc in enumerate(scenes):
        pic = raster(pack, sc["visual"]["file"], tmp) if sc.get("visual") else None
        img = slide(sc["title"], sc["eyebrow"], sc["text"], pic, sc.get("credit", "Narrated summary of the study pack. Not the authors' words."))
        png, aiff, mp4 = (os.path.join(tmp, f"s{n:02d}.{e}") for e in ("png", "aiff", "mp4"))
        img.save(png)
        subprocess.run(["say", "-v", voice, "-o", aiff, sc["say"]], check=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-i", png, "-i", aiff, "-af", "apad=pad_dur=0.8",
                        "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p", "-r", "24", "-c:a", "aac", "-b:a", "96k",
                        "-shortest", mp4], check=True)
        parts.append(mp4)
        print(f"scene {n + 1}/{len(scenes)}: {sc['title']}")
    lst = os.path.join(tmp, "list.txt")
    open(lst, "w").write("".join(f"file '{p}'\n" for p in parts))
    out_dir = os.path.join(pack, "visuals", "media")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "overview.mp4")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", "-movflags", "+faststart", out], check=True)
    secs = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out], capture_output=True, text=True).stdout or 0)

    entry = {"id": "video-overview", "file": "visuals/media/overview.mp4", "type": "video", "title": "Narrated overview",
             "purpose": f"A {round(secs / 60, 1)}-minute narrated walk through the paper's main ideas, one lesson per scene.",
             "unlock": "triage_done", "source": {"page": 1, "ref": "Abstract"},
             "alt_text": "Narrated slideshow: one scene per lesson with its picture and a plain-language summary, read aloud by a synthetic voice.",
             "analogy": False, "simple": True, "redrawn_from": None}
    visuals["visuals"] = [v for v in visuals["visuals"] if v["id"] != entry["id"]] + [entry]
    json.dump(visuals, open(vpath, "w"), indent=1, ensure_ascii=False)
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"\nWrote {out} ({os.path.getsize(out) // 1024} KB, {int(secs // 60)}:{int(secs % 60):02d}) and registered it in visuals.json.")


if __name__ == "__main__":
    main()
