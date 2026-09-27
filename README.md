# motion-video-skill

Playful, polished motion-graphics videos from one JSON file, made to be driven
by an AI agent (or by you).

Write a `story.json` with your scenes and lines. The engine renders every frame
in headless Chromium, gives each character its own ElevenLabs voice synced word
by word, synthesizes music and sound effects on the same cues, and encodes an
MP4. Vertical for TikTok, Reels and Shorts, or 16:9 and square.

![Contact sheet of the example video](docs/preview.jpg)

▶ [Watch the example (docs/preview.mp4)](docs/preview.mp4)

- **Deterministic.** `render(t)` is a pure function of time: the still you
  check is the frame that ships, and every render is identical.
- **Voice-driven timing.** Each scene lasts as long as its spoken line, snapped
  to the music's beat. Titles, list items and word stickers land on the exact
  word (`"at": "Relax"`).
- **Nothing to license.** 8 music styles and 43 sound effects, all
  synthesized ([listen to them](docs/sounds.md)); the example characters are
  drawn by a script. Bring your own media, music and effects if you like.
- **Voices from anywhere.** Generate with an ElevenLabs key, or drop in voice
  files from any tool or connected account; word timings come from
  ElevenLabs, faster-whisper, or an estimate.
- **Agent-ready.** [`SKILL.md`](SKILL.md) is a step-by-step playbook for an AI
  agent, including how to review stills and verify audio by transcription,
  since agents cannot watch or listen.

## Quick start

Requirements: Node 18+, Python 3.9+. ffmpeg is optional (a Python package
provides one).

```bash
git clone https://github.com/Clad012/motion-video-skill.git
cd motion-video-skill
npm install && npx playwright install chromium
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

node engine/make.mjs examples/smoothie-squad all
# → examples/smoothie-squad/out/smoothie-squad.mp4
```

The example ships with its voices already generated, so no API key is needed
to render it. The text-only 16:9 example needs nothing at all:

```bash
node engine/make.mjs examples/minimal all
```

## Make your own

1. Copy an example folder: `cp -r examples/minimal my-video`.
2. Put your videos and images in `my-video/media/` and list them under `media`.
3. Write the scenes in `my-video/story.json` ([reference](docs/story-schema.md)).
4. Add voices (optional): give scenes a `voice`, then either set
   `ELEVENLABS_API_KEY` (pick voices with `.venv/bin/python engine/voices.py
   my-video --list` and map speakers under `voices`), or put your own files in
   `my-video/voices/<scene id>.mp3` and let the `voices` step time them
   (`pip install faster-whisper` for precise timings).
5. Pick a music style and sprinkle effects: `"music": { "style": "lofi" }`,
   and per scene `"sounds": [{ "at": "word", "kind": "cash" }]`.
6. Iterate on stills, then render:

```bash
node engine/make.mjs my-video voices     # generate or refresh voice lines
node engine/make.mjs my-video stills     # timeline, warnings, build/contact-sheet.jpg
node engine/make.mjs my-video all        # the MP4 (add --fps 30 for fast drafts)
node engine/make.mjs my-video check      # transcribe the final mix, line by line
```

Open `my-video/build/player.html` in a browser to scrub and play the video with
its soundtrack (run `audio` first for sound).

### Using it with an AI agent

Give your agent this repository and [`SKILL.md`](SKILL.md) (for Claude Code,
put the folder in `.claude/skills/motion-video/` or `~/.claude/skills/motion-video/`),
then ask for a video: *"Make a 30-second vertical explainer for our new
recipe app, with a narrator and three talking ingredients."* The skill walks the
agent through the brief, the script, the media, voice checks, visual review and
delivery.

## Scene types

| Type | What it does | Good for |
|---|---|---|
| `pileup` | Notifications or tasks rain down and shake, words slam in on the voice, then it all blows away | The problem, the hook |
| `title` | Big lines popping in letter by letter, a slow "breathe" word, confetti | Turns, statements, reveals |
| `fan` | Media cards fan in like a hand of cards; the first grows into the next card | Introducing a cast or a range |
| `card` | A media card flies in with a name sticker, caption and a speech bubble with a live speaking meter | Characters, products, features, testimonials |
| `list` | Rows slide in on their words | Steps, tips, agendas |
| `grid` | Round avatars pop in to a rising marimba run and do a wave | "All of them together" |
| `logo` | The grid flies into the mark; name, tagline and URL pop in | Endings, calls to action |

Scenes hand off to each other: a fan's first card becomes the next card scene,
the last card shrinks into its seat in a grid, the grid gathers into the logo.

## How it works

```
story.json ─┬─ voices.py ──► voices/*.mp3 + word timings (ElevenLabs, or estimated)
            │
            └─ make.mjs prepare ──► build/  (player.html, engine.js, media frames)
                     │
                     ├─ Chromium + engine.js: timeline from voices, render(t) per frame
                     │        ├─► build/frames-out/*.jpg
                     │        └─► build/cues.json + meta.json (every sound, every scene mood)
                     │
                     ├─ sound.py ──► build/soundtrack.wav  (music by mood, effects on cues,
                     │                                       voices, ducking, -1 dB peak)
                     └─ ffmpeg ──► out/<title>.mp4 + contact sheet
```

- **Picture**: SVG for type and shapes, a canvas for media, stacked in one page
  and screenshotted per frame. Media is pre-extracted to JPEG frames because
  headless Chromium cannot decode H.264, and so seeking is exact.
- **Sound**: music follows each scene's mood (`tension`, `calm`, `groove`,
  `run`, `outro`) in the story's style, tempo and key; 43 effects (pops,
  whooshes, risers, impacts, cash registers, record scratches, a ta-da…) are
  placed on the renderer's cues and on any `sounds` you add; music ducks under
  voices. Catalogue with audio: [docs/sounds.md](docs/sounds.md); regenerate it
  with `node engine/make.mjs gallery`.
- **Voices**: ElevenLabs text-to-speech with character timestamps, so on-screen
  events can sync to words; `--check-lines` and `check` run speech-to-text to
  confirm what was actually said.

## Example credits

- Characters in `examples/smoothie-squad` are drawn by
  [`make-media.mjs`](examples/smoothie-squad/make-media.mjs); regenerate them
  with `npm run example:media`.
- Example voices were generated with ElevenLabs default voices.
- Font: [Geist](https://fonts.google.com/specimen/Geist) (SIL Open Font License), loaded from Google Fonts.
- "Smoothie Squad" and "Sleep Notes" are made-up names; `example.com` is a reserved example domain.

## License

MIT. See [LICENSE](LICENSE).
