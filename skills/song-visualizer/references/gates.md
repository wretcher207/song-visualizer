# Gates and review pages

Two gates before the full build, and a cut page after it. Each is a page the person opens, with one card per thing to
judge and an "ok" / "work" mark and a note on every card. You read the marks back and apply every "work" before the
next stage. Present each gate as a page, not as file paths in chat.

## Gate A: key frames

1. Draw the brief's key frames as stills: `python dev/shot.py --out gatea --small 640 0 17 110 145 227`, and the same
   times with `--aspect v`.
2. Look at each at full size and at 640 px. When something has to read as a specific thing (a building, a car, a
   figure), show the 640 px still to a fresh agent with a neutral file name and no hints, and ask what it sees.
3. One card per key frame (the still, its 640 px copy, the vertical), one card for phones (the verticals side by
   side), and a call for each decision you made that the brief didn't (say what and why, plainly).

## Gate B: the preview

1. `python tools/render.py window START 12 --name gateb`, then `python tools/qa.py dev/out/gateb.mp4 --start START`.
   Look at every contact sheet.
2. One card for the clip (what happens, second by second), cards for any new stills, a phones card, and calls.

## The cut page

After the full build: one card for the whole film (`"film": "final/<slug>.mp4"`, streamed in parts), cards for each
part of the song with stills, the vertical film, the thumbnail and cover, and calls.

## Building a page

Write the spec as `review/<name>.json` (the format is in `tools/review.py`'s header), then:

```bash
python tools/review.py review/gate-a.json
```

It writes `review/<name>.html` (for publishing), `review/<name>.local.html` (to open from disk), the media in
`review/media-<name>/`, and `review/<name>.publish.json` (the files split into publish batches).

Writing the cards: lead with what to look for, in plain words, in the order it happens. Times as m:ss. Say what the
person will see, not how it was built. Calls say what you chose and why in two or three sentences, so the person can
agree or redirect in the note.

## Publishing it (Claude artifacts)

If the Artifact tool is available, publish the page so the marks save where you can read them:

1. Publish `review/<name>.html` with capabilities `{ "db": {}, "user": {} }` and the first batch's files as `files`
   (published path to source path, exactly as the publish plan lists them).
2. Publish each later batch to the same page (same file path, later batches as `files`). Files must each be under
   15 MB, one publish at most 64 MB: the plan already respects both.
3. Give the person the link.

Reading the marks: ArtifactData `list` on the page's URL, collection `reviews`. One document per card id:
`{ verdict: "ok" | "work" | "", note }`. A card with no document hasn't been marked. Don't treat an unmarked card as
passed: ask about it, or say plainly which cards are still unmarked.

## Without artifacts

Open `review/<name>.local.html` (or serve the folder: `python -m http.server` in `review/`). Marks save in that browser;
the person presses "Copy my marks" and pastes the JSON to you: `{ "card-id": { "verdict": "ok", "note": "" } }`.
