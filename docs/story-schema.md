# story.json reference

A video is one `story.json` in a project folder. The engine turns it into a
timeline, renders every frame, builds the soundtrack and encodes an MP4.

```
my-video/
  story.json      the whole video
  media/          your videos and images (any names)
  voices/         generated voice lines + voices.json (commit them)
  build/          generated, safe to delete
  out/            the final MP4 and a contact sheet
```

## Top level

| Field | Type | Default | Meaning |
|---|---|---|---|
| `title` | string | folder name | Used for the output file name. |
| `format.width`, `format.height` | px | 1080 × 1920 | 1080×1920 portrait (TikTok, Reels, Shorts), 1920×1080 landscape, 1080×1080 square. |
| `format.fps` | number | 60 | Render frame rate. Use `--fps 30` for fast drafts. |
| `language` | ISO code | none | Passed to ElevenLabs (`"en"`, `"fr"`, `"es"`…). |
| `style.font` | Google Font name | `"Geist"` | Loaded from Google Fonts. |
| `style.fontWeights` | number[] | `[500,600,700,800]` | Weights to load. |
| `style.paper`, `style.ink` | hex | `#f4f3ef`, `#1c1c1b` | Base background and text colour. |
| `style.accent` | colour name or hex | `"violet"` | Default highlight colour. |
| `style.palette` | `{name: hex}` | 8 built-ins | Adds or overrides named colours. Built-ins: `blue violet green amber rose teal copper slate`. |
| `style.decor` | boolean | `true` | Soft floating circles behind scenes. |
| `music.style` | name | `"playful"` | `playful`, `lofi`, `upbeat`, `cinematic`, `chiptune`, `tropical`, `corporate`, `ambient`. Hear them in [sounds.md](sounds.md). |
| `music.file` | path | none | Your own music track instead of a style (looped, faded, ducked under voices). |
| `music.bpm` | number | the style's | Scene lengths snap to this beat. |
| `music.key` | `C`…`B` (`F#`, `Bb`…) | `"C"` | Transposes all music and melodic effects. |
| `music.progression` | chord names | `["C","Am","F","G"]` | One chord per groove scene, cycling. Written in C; transposed to `key`. |
| `music.volume` | 0–1 | 0.55 | Music level (sound effects and voices are separate). |
| `music.enabled` / `music.sfx` | boolean | `true` | Turn music or sound effects off. |
| `autoSfx` | boolean | `true` | `false` keeps only the sounds scenes place by hand (see `sounds`). |
| `voices` | `{who: voiceId}` | | ElevenLabs voice ids per speaker. List yours: `python engine/voices.py <project> --list`. |
| `voiceSettings.model` | string | `"eleven_v3"` | `eleven_v3` understands audio tags like `[excited]`; `eleven_multilingual_v2` is steadier. |
| `voiceSettings.stability`, `.similarity` | 0–1 | 0.5, 0.8 | Passed to ElevenLabs. `eleven_v3` accepts stability 0, 0.5 or 1. |
| `media` | `{id: path}` or `{id: {full, avatar}}` | | Videos (mp4/mov/webm/gif), images (png/jpg/webp) or folders of frames. `full` is used on cards, `avatar` (square) in grids; each falls back to the other. |
| `labels` | `{now, number}` | `{now: "now", number: "No."}` | Small UI words, for other languages. |
| `scenes` | array | | The video, in order. |

## Every scene

| Field | Meaning |
|---|---|
| `type` | `pileup`, `title`, `fan`, `card`, `list`, `grid`, `logo`. |
| `id` | Optional name; also the voice file name. Default `s1`, `s2`… |
| `voice` | `{ "who": "narrator", "text": "What is said.", "at": 0.35 }`. `at` is when speech starts, in seconds from the scene start. |
| `duration` | Minimum length in seconds. With a voice, the scene is at least as long as the line plus `pad` (0.55 s). Always rounded up to whole beats. |
| `background` | Colour name or hex. Tinted towards paper unless `"tint": false`. `"paper"` for plain. Changes wipe in as a circle. |
| `mood` | Music for this scene: `tension`, `calm`, `groove`, `run`, `outro`, `none`. Defaults: pileup tension, title and fan calm, card and list groove, grid run, logo outro. |
| `sounds` | Extra sound effects: `[{ "at": "word", "kind": "whoosh", "gain": 1, "pitch": 1, "dur": 0.5 }]`, or `{ "at": 1.2, "file": "sounds/hit.wav" }` for your own. 43 kinds, listed with audio in [sounds.md](sounds.md). |
| `autoSfx` | `false` turns off the effects this scene type plays by itself. |

### Voice files made elsewhere

`voices/<scene id>.mp3` (or `.wav`, `.m4a`, `.ogg`) is used as that scene's
voice when you put it there yourself: from another text-to-speech tool, an
ElevenLabs account connected through an integration, or a recording. The
`voices` step times its words, from `voices/<scene id>.alignment.json` when
present (the ElevenLabs with-timestamps response), else with faster-whisper
when installed (`pip install faster-whisper`; `WHISPER_MODEL=small` by default),
else by estimating across the speech it detects. `voice.text` must still hold
what is said: word sync and checks rely on it. `--import` re-times every file.

### Timing values (`at`, `until`)

Anything called `at` accepts:

- a number: seconds from the scene start (`1.2`);
- a spoken word: `"Relax"` is when that word starts in the scene's voice line
  (prefix match, case and accents ignored); `"fruit#2"` is the second match;
  `"Relax:end"` is when the word finishes.

A word that is not found falls back to a default time and is reported as a
warning by `make.mjs stills`.

## Scene types

### `pileup`: too much, then relief
Cards (notifications, tasks, bills) rain down and shake harder and harder,
words slam in on the beat of the voice, a headline lands, then everything is
blown away in the last half second.

```json
{ "type": "pileup",
  "voice": { "text": "Bills, emails, meetings... too much?" },
  "items": [ { "icon": "B", "title": "Electricity", "body": "Due Friday", "color": "amber", "time": "now" } ],
  "slams": [ { "text": "Bills", "at": "Bills" } ],
  "headline": { "text": "too much?", "at": "too", "color": "rose" } }
```
8 to 16 items reads as "overwhelming". Up to 4 slams.

### `title`: big kinetic words
Lines stack in the middle; each pops in letter by letter at its `at`.

```json
{ "type": "title", "lines": [
  { "text": "Relax.", "at": "Relax", "until": "Meet", "breathe": true },
  { "text": "Meet the", "at": "Meet" },
  { "text": "team.", "at": "team", "big": true, "color": "violet", "confetti": true } ],
  "badge": { "text": "Acme", "at": "Acme" } }
```
Line fields: `text`, `at`, `until` (leaves early), `big` (huge, bouncy),
`breathe` (slowly grows in the centre, for calm words; not stacked),
`color`, `size` (design px), `weight`, `confetti`, `y` (0–1 of height, breathe lines only).

### `fan`: a hand of cards
Everything from `title`, plus `cards` (media ids) that fan in from the bottom
at `cardsAt`. If the next scene is a `card` showing `cards[0]`, that card grows
into it: a seamless hand-off.

### `card`: one character, product or photo
A big media card flies in from alternating sides and lands with a squish.

| Field | Meaning |
|---|---|
| `media` | Media id (uses its `full` variant). |
| `color` | Sticker, progress and bubble accent. |
| `name` | Sticker over the bottom edge. |
| `caption` | One line under the card. |
| `bubble` | Speech bubble above the card; pops when the voice starts, with a live "speaking" meter. Keep it shorter than the spoken line. |
| `number` | `false` hides the "No. 01" badge, or a string replaces it. |
| `progress` | `false` hides the dots shown across a run of consecutive cards. |

The card squashes slightly on every spoken word.

### `list`: steps, tips, agenda
A title and rows that slide in from alternating sides at their `at`.

```json
{ "type": "list", "title": "How it works",
  "items": [ { "text": "Pick a plan", "at": "Pick", "icon": "1", "color": "teal" } ] }
```
3 to 5 items. `icon` defaults to the item number.

### `grid`: everyone together
Round avatars pop in one by one (each plays a marimba note, rising), then do a
wave. Title lines (same as `title`) above, `footer` below.

```json
{ "type": "grid", "lines": [ { "text": "Six fruits.", "at": "Six" } ],
  "members": [ { "media": "banana", "color": "banana" } ],
  "footer": { "text": "Mix your own.", "at": "Endless" }, "columns": 3 }
```
If the previous scene is a `card` whose media is a member, it shrinks into its seat.

### `logo`: the ending
A mark, the name, a tagline and a URL. If the previous scene is a `grid`, the
members fly into the mark first.

| Field | Meaning |
|---|---|
| `name`, `nameAt` | Wordmark and when it pops. |
| `monogram` | Letter in the default rounded-square mark (default: first letter of `name`). |
| `image` | Media id of a logo image instead (PNG keeps transparency). |
| `color` | Mark colour. |
| `markSize` | Mark size in design px (300). |
| `tagline` | Parts of one line, each popping at its own `at`, each with its own `color`. |
| `url`, `urlAt` | Small line under the tagline. |

## Adding a scene type

Scene types live in `engine/engine.js` in the `SCENES` registry. Each has
`render(sc, t)`, which appends SVG to `front`/`back` and media draw calls to
`media`, and `cues(sc, add)`, which adds sound-effect cues. Everything must be
a pure function of `t`: no timers, no randomness except `hash(n)`.
