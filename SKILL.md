---
name: motion-video
description: Make playful, polished motion-graphics videos (explainers, product promos, teasers, announcements, tutorials, social clips for TikTok/Reels/Shorts or 16:9) from a single story.json. Kinetic typography, media cards, lists, grids and logo endings, character voices synced word by word (ElevenLabs by API key, or voice files from any tool or connected account), 8 synthesized music styles and 43 sound effects, rendered frame-exact to MP4. Use when someone asks for an animated video, a motion graphic, a short vertical video, or a narrated explainer.
---

# Motion video

You write a `story.json` (the script, the scenes, the look). The engine derives
the timeline from it, renders every frame in headless Chromium, synthesizes
music and sound effects on the same cues, mixes in the voices and encodes an
MP4. `render(t)` is a pure function of time, so a still you review is exactly
the frame that ships.

Repository layout:

```
engine/make.mjs      the pipeline (run everything from here)
engine/engine.js     scene types + timeline + cues (the renderer)
engine/voices.py     ElevenLabs voices with word timings, speech-to-text checks
engine/sound.py      music + effects + voices -> soundtrack.wav (sfx.py, music.py)
docs/story-schema.md every story.json field (read it before writing one)
docs/sounds.md       the 8 music styles and 43 sound effects, each with an MP3
examples/            smoothie-squad (every scene type, voices), minimal (text only, 16:9)
```

## Setup (once per machine)

```bash
npm install && npx playwright install chromium
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

ffmpeg is used from PATH, or from `FFMPEG`, or from the `imageio-ffmpeg`
package installed above, so nothing else is required.

Voices come from one of three places, in this order of preference:
1. **Voice files you make yourself** (another TTS, an ElevenLabs account
   connected through an integration or toolkit, a recording): save each line
   as `voices/<scene id>.mp3`; the `voices` step times the words (faster-whisper
   when installed, which is the precise option: `pip install faster-whisper`).
2. **An API key**: `ELEVENLABS_API_KEY` in the environment or a `.env` /
   `.env.local` file; the `voices` step generates every line with word timings.
3. **Neither**: estimated timings, and the video is silent where voices go.
Never ask a user to paste an API key into a chat when their account is
already connected another way.

## Workflow

Follow these steps in order. Do not skip the review steps: you cannot watch or
hear the video, so stills and transcripts are how you see and listen.

### 1. Understand the brief
Find out: what the video is for, who watches it, where it is posted (sets the
format: 1080×1920 vertical for TikTok/Reels/Shorts, 1920×1080 for YouTube or
slides, 1080×1080 for feeds), the language, the length (15 to 45 s is the sweet
spot), the call to action, and what media exists (product shots, characters,
screen recordings, logo). Ask only for what you cannot sensibly default.

### 2. Write the script as beats
One idea per scene, one short spoken line per scene. A shape that works for
almost anything:

| Beat | Scene type | Job |
|---|---|---|
| Hook: the problem | `pileup` (or `title`) | Make the pain visible in 3 to 6 s. |
| Turn | `title` or `fan` | Relief, the reveal ("Relax. Meet…"). |
| Proof, one by one | `card` × 3 to 7 | Each thing / feature / person speaks for itself. |
| How it works | `list` | 3 to 5 steps or tips. |
| Everyone together | `grid` | Scale, the whole range. |
| Ending | `logo` | Name, tagline, URL. |

Drop beats you do not need: an announcement can be `title` → `list` → `logo`; a
cast intro can be `fan` → `card`s → `grid` → `logo`.

Writing rules that matter on screen:
- Spoken lines: 1.5 to 4 s each (about 4 to 12 words). The scene stretches to
  fit its line, rounded up to whole beats.
- On-screen text is shorter than speech. A bubble echoes the spoken line in
  fewer words; a caption says what the thing is.
- Put the words you want to sync on screen at the start of their phrase, and
  reference them with `"at": "word"`. Slams, list items and title lines land
  exactly when the word is said.
- Avoid words with an unfortunate near-homophone in the target language; speech
  recognition (and viewers) will hear it.
- Names: write them phonetically in `voice.text` if the model says them wrong
  (for example "Shiv-awn" for Siobhan) and keep the real spelling in on-screen
  fields. `at` references use the spoken spelling.
- With `eleven_v3` you can add audio tags: `[excited]`, `[cheerfully]`,
  `[giggles]`, `[warmly]`. They are not spoken and not counted as words.

### 3. Gather media
Every `card`, `fan` and `grid` needs media: a video, an image, or a folder of
frames. Portrait art around 9:16 suits cards (they crop to about 5:8, biased to
keep heads); a square close-up suits grid avatars (`"avatar"`). Loops of 2 to 4 s
are ideal. If the user has no media, generate it: see
`examples/smoothie-squad/make-media.mjs`, which draws animated characters as
SVG and renders them to MP4. Never use media you do not have the rights to.

### 4. Write story.json
Start from the closest example and read `docs/story-schema.md`. Choose voices
per speaker (`python engine/voices.py <project> --list`); give each character
a clearly different voice and the narrator a warm, steady one. Pick colours
from the palette or add your own.

### 5. Voices, then check them by ear, through transcription
With your own voice files (connected account, other tool): write each scene's
line to `voices/<scene id>.mp3` using exactly the scene's `voice.text` (drop
audio tags like `[excited]` if the tool does not understand them), one voice
per speaker, same model and settings for all. Then:
```bash
node engine/make.mjs <project> voices     # times new files, or generates with a key
.venv/bin/python engine/voices.py <project> --check-lines   # needs a key
```
With a key, every line should say OK. For each CHECK, read "heard": fix the
text (rephrase, spell phonetically, change the voice) and run `voices` again.
It only regenerates lines whose text or voice changed; `--force` redoes all;
`--import` re-times files you replaced. Without a key, check each file with
faster-whisper: `--check-lines` and `check` use it automatically when no key
is set.

### 5b. Choose the sound
Pick a music style that fits the tone (`docs/sounds.md` describes each):
playful for light and funny, lofi for calm explainers, upbeat for launches,
cinematic for reveals, chiptune for games and tech, tropical for travel and
food, corporate for product tours, ambient for wellness. Scenes already play
their own effects; add a few by hand where a moment deserves one (`sounds`:
a squeak on a joke word, a `cash` on a price, a `rise` into a reveal, one
`impact` at most). Less is more: 2 to 6 hand-placed sounds in a 30 s video.

### 6. Render stills and look at them
(If your environment forbids looking at images, skip the contact sheet but
still run the command: its text output, the timeline and the warnings, catches
most mistakes. Fix every warning.)

```bash
node engine/make.mjs <project> stills            # 2 per scene
node engine/make.mjs <project> stills 1.2 4.8 9  # or chosen times
```
This prints the timeline and any warnings (unknown words in `at`, missing
media). Open `build/contact-sheet.jpg` and check every frame for:
- text colliding with text or leaving the frame;
- confetti or stickers covering faces or key content;
- the first second: is something on screen already (it becomes the thumbnail)?
- vertical safe zones: keep key text out of the top 8% and the bottom 15%,
  where platform UI sits;
- anything that looks empty or cramped for too long.
Fix story.json (or the engine) and repeat until the sheet is clean.

### 7. Render the video
```bash
node engine/make.mjs <project> all          # prepare, voices, frames, audio, encode
node engine/make.mjs <project> all --fps 30 # twice as fast; use it on small machines
```
On a one-CPU machine rendering runs at a few frames per second: a 30 s video at
30 fps takes several minutes, so run it in the background when you can.
Or step by step: `frames`, `audio`, `encode`. The output is
`out/<title>.mp4` plus `out/<title>-sheet.jpg` (one frame every 1.5 s).
Rendering runs at about 10 to 20 frames per second.

### 8. Verify the final file
- Look at `out/<title>-sheet.jpg`.
- `node engine/make.mjs <project> check` transcribes the final mix (ElevenLabs
  with a key, faster-whisper without) and shows each expected line as OK or
  CHECK: voices must be audible over the music.
- `ffprobe -v error -show_entries format=duration:stream=codec_type,width,height -of json out/<title>.mp4`:
  the planned duration and size, and an audio stream.
- Report the length, the format and anything you could not verify (for
  example: nobody has listened to the tone of the voices).

## Deliver
Give the MP4 path, the length and format, the voice cast, and the lines you
wrote that make claims, so the user can confirm them. Mention the thumbnail
frame if the first frame is plain.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Playwright missing` | `npm install && npx playwright install chromium` |
| `ffmpeg not found` | `brew install ffmpeg`, `apt install ffmpeg`, or `.venv/bin/pip install imageio-ffmpeg` |
| Warning `word "x" not found` | The `at` word is not in that scene's `voice.text` (check spelling, or the phonetic version). |
| A voice mispronounces a name | Spell it phonetically in `voice.text`; re-run `voices` and `--check-lines`. |
| A card or avatar is grey | Its media id is missing from `story.media`, or the file path is wrong. |
| Voice drowned by music | Lower `music.volume` (0.4) or set the scene's `mood` to `calm`. |
| Video too long | Shorten spoken lines first; scene length follows the voice. |
| Browser video formats | Headless Chromium lacks H.264, so the engine extracts media to JPEG frames in `prepare`; any format ffmpeg reads works. |

## Extending
New scene types go in the `SCENES` registry in `engine/engine.js`: a
`render(sc, t)` that draws (pure function of `t`, randomness only via
`hash(n)`) and a `cues(sc, add)` that schedules sound effects. Add its default
length to `DEFAULT_LEN` and its music mood to `DEFAULT_MOOD`, then document it
in `docs/story-schema.md`.
