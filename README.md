# Song Visualizer

Song Visualizer is a Claude Code plugin (one skill, `song-visualizer`) that makes a music visualizer for a song. Everything on screen is drawn in code, JavaScript on canvas and WebGL, and rendered frame by frame to video with HyperFrames, which is free, open source and turns HTML into video. There are no AI image or video generators in it and no stock footage.

It isn't a one-click button. You write a brief, approve key frames, and watch a preview of the hardest stretch before the full build starts. It's the workflow I used for the visualizers for ayin hara's EP *an elegy*, four songs set in and around Houlton, Maine.

## How it works

Claude walks you through it in this order.

1. **New project.** Point it at a WAV and give it a title. It copies its own tools into the project folder, so the project keeps working whatever happens to the plugin.
2. **The brief.** Claude asks about the song, the place, what's always in frame and what's never in frame, the look, and where the song turns. Your answers become `BRIEF.md`.
3. **Measure the song.** It analyzes the audio into per-frame tables (energy, bass, mids, highs, hits, beats) and finds where instruments come in and drop out. Then it pins cues to the exact frame a sound starts, including the hit that doesn't come, like the moment the hats stop.
4. **Build the world.** A starter scene (snow falling toward a warm light, gusting on the kick) renders on day one. You and Claude replace it with your world. The engine has 3D snow, dust and ash on the GPU, paper, charcoal and pencil marks, hand-drawn line wobble, film grain, and an end card set in any font you're allowed to embed.
5. **Gate A.** Key frames go up as stills on a review page, and you mark each card "ok" or "work" with a note.
6. **Gate B.** A 10 to 15 second preview of the hardest stretch of the song, rendered for real with sound and put on a page.
7. **Full build.** 16:9 and 9:16 renders. Every frame gets checked for black frames, freezes, flashes and one-frame glitches, and Claude looks at contact sheets covering every frame. Fixes get patched into a short window instead of a full re-render. Then come the share and phone copies (the phone copy sized under 29 MB), a thumbnail, a vertical cover, and a cut page with both films.

Review pages go up as Claude artifacts if you ask for that, and your marks save where Claude reads them back. Opened as a plain file, the marks save in your browser instead, and a button copies them so you can paste them to Claude.

## What you need

- Claude Code
- Python 3.10+ with numpy, scipy, librosa, soundfile and pillow (plus fonttools for end cards)
- ffmpeg
- Node.js 20+ and pnpm

HyperFrames comes through pnpm the first time you render, pinned to 0.8.77, and it downloads its own headless Chrome. Claude runs a setup check that names anything missing and the command that fixes it.

## Install

In Claude Code:

```
/plugin marketplace add wretcher207/song-visualizer
/plugin install song-visualizer@song-visualizer
```

Or try it from a clone:

```
git clone https://github.com/wretcher207/song-visualizer.git
claude --plugin-dir ./song-visualizer
```

Then ask Claude to make a visualizer for your song and give it the WAV.

## What it costs you (time and disk)

Machine time. A full 1080p render on a 4-core CPU runs about 70 to 80 minutes for a 4-minute song, and that's per aspect, so the 16:9 and the vertical each take that long. The frames take 8 to 16 GB of disk per aspect until you accept the cut.

And taste. The tool can push you toward a strong brief, but the result is only as good as the direction you give it.

## What it runs and sends

Everything runs on your machine. The tools are plain Python and JavaScript, and they read your WAV and write files in your project folder. pnpm downloads HyperFrames, and HyperFrames downloads a headless Chrome the first time you render.

The tools don't read credentials or API keys, and they don't read environment variables except to start a long render in the background, where they set HYPERFRAMES_RENDER_DETACHED so HyperFrames keeps going after the command that started it exits. The only network calls the review pages make are the film player fetching the page's own video parts and, when the page is published as a Claude artifact, saving your marks through Claude's artifact storage.

Review pages are only published if you ask Claude to publish them as Claude artifacts (private to you until you share them). Otherwise they stay local files. Your song is never uploaded by these tools, but a review page you publish carries the clips and stills on it, and the clips have the song's audio in them. Claude Code itself talks to Anthropic like any Claude Code session.

## Want one made?

If you'd rather have one made for you, Dead Pixel Design makes these to order: [www.deadpixeldesign.com](https://www.deadpixeldesign.com)

## License

MIT. Made by Dead Pixel Design.
