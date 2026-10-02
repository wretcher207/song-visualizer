"""The end card's words as outlines, so the end card needs no font at render time: the artist and the title from
visualizer.json, set in the font at fonts.endcard (any TTF or OTF; a variable font takes fonts.endcardWeight),
tracked 0.35 em with a word space of two average letter gaps.

  python tools/endcard_type.py [--tracking 0.35] [--word-gap 2.0]
        writes lib/endtype.js (window.ENDTYPE: the artist line and the title line); run tools/build.py after, so the
        pages load it. Use a font you're allowed to embed (the open-font-licence families on Google Fonts all are).

Units: the em (the font size), y up from the baseline, x from the line's left ink edge; contours fill even-odd.
"""
import argparse, json, pathlib, sys

from fontTools.pens.basePen import BasePen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import project  # noqa: E402

ROOT = project.ROOT
TRACKING_EM = 0.35
WORD_GAP = 2.0


class Flat(BasePen):
    def __init__(self, gs, steps=8):
        super().__init__(gs)
        self.contours, self.cur, self.steps = [], [], steps

    def _moveTo(self, p):
        self.cur = [p]

    def _lineTo(self, p):
        self.cur.append(p)

    def _qCurveToOne(self, p1, p2):
        p0 = self.cur[-1]
        for i in range(1, self.steps + 1):
            t = i / self.steps
            u = 1 - t
            self.cur.append((u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]))

    def _curveToOne(self, p1, p2, p3):
        p0 = self.cur[-1]
        for i in range(1, self.steps + 1):
            t = i / self.steps
            u = 1 - t
            self.cur.append(tuple(u ** 3 * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t ** 3 * p3[k] for k in (0, 1)))

    def _closePath(self):
        if len(self.cur) > 2:
            if self.cur[0] == self.cur[-1]:
                self.cur.pop()
            self.contours.append(self.cur)
        self.cur = []

    _endPath = _closePath


def set_line(font, text):
    upm = font["head"].unitsPerEm
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    hmtx = font["hmtx"]
    track = TRACKING_EM * upm
    glyphs, starts, pen = [], [], 0.0  # [name, pen_x, ink_x0, ink_x1, contours]
    for word in text.split():
        starts.append(len(glyphs))
        for ch in word:
            name = cmap[ord(ch)]
            p = Flat(gs)
            gs[name].draw(p)
            xs = [x for c in p.contours for x, _ in c]
            glyphs.append([name, pen, min(xs), max(xs), p.contours])
            pen += hmtx[name][0] + track
    gaps = [(glyphs[j + 1][1] + glyphs[j + 1][2]) - (glyphs[j][1] + glyphs[j][3])
            for s, w in zip(starts, text.split()) for j in range(s, s + len(w) - 1)]
    gap = sum(gaps) / len(gaps)
    for s in starts[1:]:
        prev = glyphs[s - 1]
        shift = prev[1] + prev[3] + WORD_GAP * gap - (glyphs[s][1] + glyphs[s][2])
        for g in glyphs[s:]:
            g[1] += shift
    left = glyphs[0][1] + glyphs[0][2]
    right = max(g[1] + g[3] for g in glyphs)
    contours = [[[round((g[1] + x - left) / upm, 5), round(y / upm, 5)] for x, y in c] for g in glyphs for c in g[4]]
    ys = [y for c in contours for _, y in c]
    return {"text": text, "ink": round((right - left) / upm, 5), "top": round(max(ys), 5), "bottom": round(min(ys), 5), "contours": contours}


def main():
    global TRACKING_EM, WORD_GAP
    ap = argparse.ArgumentParser()
    ap.add_argument("--tracking", type=float, default=TRACKING_EM, help="letter spacing, in ems")
    ap.add_argument("--word-gap", type=float, default=WORD_GAP, help="word space, in average letter gaps")
    a = ap.parse_args()
    TRACKING_EM, WORD_GAP = a.tracking, a.word_gap
    c = project.load()
    if not c["fonts"].get("endcard"):
        sys.exit("set fonts.endcard in visualizer.json to a TTF or OTF file first")
    font = TTFont(str(project.path(c["fonts"]["endcard"])))
    if "fvar" in font:
        font = instantiateVariableFont(font, {"wght": c["fonts"].get("endcardWeight", 300)})
    title = set_line(font, c["title"])
    if c["artist"].strip():
        data = {"artist": set_line(font, c["artist"]), "title": title}
    else:
        # no artist line: the title takes the top line, and the second line is empty
        data = {"artist": title, "title": {**title, "contours": []}}
    out = ROOT / "lib" / "endtype.js"
    out.write_text("// The end card's words as outlines, from tools/endcard_type.py. Units: the em,\n"
                   "// y up from the baseline, x from the left ink edge; fill even-odd.\n"
                   f"window.ENDTYPE = {json.dumps(data, separators=(',', ':'))};\n", encoding="utf-8")
    print(f"wrote {out}: artist ink {data['artist']['ink']} em, title ink {data['title']['ink']} em, "
          f"{sum(len(c) for c in data['artist']['contours']) + sum(len(c) for c in data['title']['contours'])} points"
          " (run tools/build.py so the pages load it)")


main()
