"""Soundtrack for a motion-video project: music, sound effects and voices.

    python engine/sound.py <project>

Reads build/meta.json and build/cues.json (exported by the renderer) and the
voice files, and writes build/soundtrack.wav. Everything except the voices is
synthesised here, so there is nothing to license.

Music follows each scene's mood (story.json "mood", or a default per type):
  tension  a clock ticking faster over a rising drone (problems piling up)
  calm     a soft chord and a marimba arpeggio (relief, a reveal)
  groove   drums, bass and a marimba riff, one chord per scene
  run      the groove without the riff (the scene plays its own notes)
  outro    a warm held chord under the ending
  none     silence
The music ducks under every voice line.
"""
import json
import os
import subprocess
import sys

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt

SR = 44100
PROJECT = os.path.abspath(sys.argv[1])
BUILD = os.path.join(PROJECT, "build")
META = json.load(open(os.path.join(BUILD, "meta.json")))
CUES = json.load(open(os.path.join(BUILD, "cues.json")))
VOICES_PATH = os.path.join(PROJECT, "voices", "voices.json")
VOICES = json.load(open(VOICES_PATH, encoding="utf8")) if os.path.exists(VOICES_PATH) else {}
DUR = META["duration"]
N = int(SR * DUR) + 1
BEAT = META["beat"]
MUSIC = META["music"]
rng = np.random.default_rng(7)

music = np.zeros((N, 2))
sfx = np.zeros((N, 2))
voice = np.zeros((N, 2))


def ffmpeg_path():
    if os.environ.get("FFMPEG"):
        return os.environ["FFMPEG"]
    from shutil import which
    if which("ffmpeg"):
        return "ffmpeg"
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def t_axis(d):
    return np.arange(int(SR * d)) / SR


def place(buf, sig, at, gain=1.0, pan=0.0):
    i = int(round(at * SR))
    if i >= N or len(sig) == 0:
        return
    if i < 0:
        sig, i = sig[-i:], 0
    sig = sig[: N - i]
    left, right = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    buf[i : i + len(sig), 0] += sig * gain * left
    buf[i : i + len(sig), 1] += sig * gain * right


def band(sig, lo, hi):
    return sosfilt(butter(2, [lo, hi], btype="band", fs=SR, output="sos"), sig)


def lowpass(sig, f):
    return sosfilt(butter(2, f, btype="low", fs=SR, output="sos"), sig)


def highpass(sig, f):
    return sosfilt(butter(2, f, btype="high", fs=SR, output="sos"), sig)


def glide(f):
    return 2 * np.pi * np.cumsum(f) / SR


KEYS = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": -3, "A#": -2, "Bb": -2, "B": -1}
SHIFT = KEYS.get(MUSIC.get("key", "C"), 0)
C4 = -9 + SHIFT  # semitones from A4


def note(semis):
    return 440.0 * 2 ** (semis / 12)


def chord(name):
    """Chord tones (semitones from A4) for names like C, Am, F, G7 in C major, shifted to the key."""
    roots = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    root = roots[name[0]] + (1 if name[1:2] == "#" else -1 if name[1:2] == "b" else 0)
    minor = "m" in name[1:3] and "maj" not in name
    root = C4 + root - (12 if root > 6 else 0)
    return [root, root + (3 if minor else 4), root + 7]


# ---------- Instruments ----------
def kick():
    t = t_axis(0.4)
    return np.sin(glide(48 + 110 * np.exp(-t * 32))) * np.exp(-t * 9) + 0.3 * rng.standard_normal(len(t)) * np.exp(-t * 300)


def clap():
    t = t_axis(0.25)
    env = sum(np.where(t >= o, np.exp(-(t - o) * 90), 0) for o in (0.0, 0.011, 0.022)) + 0.5 * np.exp(-t * 18)
    return band(rng.standard_normal(len(t)), 900, 3200) * env * 1.6


def hat(decay=70, d=0.06):
    t = t_axis(d)
    return highpass(rng.standard_normal(len(t)), 7000) * np.exp(-t * decay)


def marimba(f, d=0.6):
    t = t_axis(d)
    return (np.sin(2 * np.pi * f * t) * np.exp(-t * 6) + 0.35 * np.sin(2 * np.pi * f * 4 * t) * np.exp(-t * 22)
            + 0.1 * np.sin(2 * np.pi * f * 9.2 * t) * np.exp(-t * 40)) * (1 - np.exp(-t * 900))


def bass(f, d=0.28):
    t = t_axis(d)
    saw, sq = 2 * ((f * t) % 1) - 1, np.sign(np.sin(2 * np.pi * f * t))
    return lowpass(0.6 * saw + 0.4 * sq, 700) * np.exp(-t * 7) * (1 - np.exp(-t * 400))


def pad(freqs, d, attack=0.4, release=0.3):
    t = t_axis(d)
    s = np.zeros_like(t)
    for f in freqs:
        for det in (-0.12, 0.12):
            s += 2 * ((f * 2 ** (det / 12) * t + rng.random()) % 1) - 1
    return lowpass(s / (len(freqs) * 2), 1400) * np.minimum(1, t / attack) * np.clip((d - t) / release, 0, 1)


# ---------- Music, scene by scene ----------
PROGRESSION = MUSIC.get("progression", ["C", "Am", "F", "G"])
RIFF = [0, None, 2, 1, None, 2, 3, 2]
scenes = META["scenes"]
groove_index = 0
if MUSIC.get("enabled", True):
    for i, sc in enumerate(scenes):
        start, length, mood = sc["start"], sc["len"], sc["mood"]
        nxt = scenes[i + 1]["mood"] if i + 1 < len(scenes) else None
        tonic = chord(PROGRESSION[0])
        if mood == "tension":
            at, gap = start + 0.1, 0.32
            while at < start + length - 0.6:
                place(music, hat(120, 0.03), at, 0.35 + 0.4 * (at - start) / length, pan=0.5 * (-1) ** int(at / gap))
                gap = max(0.09, gap * 0.93)
                at += gap
            t = t_axis(length)
            f = note(tonic[0] - 24) * (1 + 0.06 * t / length)
            saw = lambda ff: 2 * ((np.cumsum(ff) / SR) % 1) - 1  # noqa: E731
            drone = lowpass(saw(f) + 0.5 * saw(f * 1.5), 500)
            drone *= np.minimum(1, t / 0.6) * (0.3 + 0.7 * t / length) * np.clip((length - 0.55 - t) / 0.05, 0, 1)
            place(music, drone, start, 0.35)
        elif mood == "calm":
            place(music, pad([note(tonic[0] - 12)] + [note(x) for x in tonic] + [note(tonic[0] + 11)], length + 0.3, 1.2, 0.4), start, 0.22)
            arp, k, at = [0, 4, 7, 12, 16, 12, 7, 4], 0, start + min(1.0, length * 0.3)
            while at < start + length - 0.05:
                place(music, marimba(note(tonic[0] + 12 + arp[k % 8])), at, 0.2, pan=0.3 * np.sin(k))
                at += BEAT / 2
                k += 1
            if nxt in ("groove", "run"):
                for j, off in enumerate([2 * BEAT, BEAT, BEAT / 2, BEAT / 4]):
                    place(music, clap(), start + length - off, 0.2 + 0.1 * j)
        elif mood in ("groove", "run"):
            root, third, fifth = chord(PROGRESSION[groove_index % len(PROGRESSION)])
            groove_index += 1
            tones = [root + 12, third + 12, fifth + 12, root + 24]
            beats = max(1, round(length / BEAT))
            for b in range(beats):
                at = start + b * BEAT
                place(music, kick(), at, 0.8)
                if b % 2 == 1:
                    place(music, clap(), at, 0.42)
                place(music, hat(), at + BEAT / 2, 0.2, pan=0.4)
                place(music, hat(), at + BEAT * 0.75, 0.09, pan=-0.3)
            for e in range(beats * 2):
                at = start + e * BEAT / 2
                place(music, bass(note(root - 12 + (12 if e % 2 else 0))), at, 0.5)
                tone = RIFF[(e + i) % 8]
                if tone is not None and mood == "groove":
                    place(music, marimba(note(tones[tone])), at, 0.2, pan=0.25 * np.cos(e))
        elif mood == "outro":
            hold = start + 0.6
            place(music, pad([note(tonic[0] - 12)] + [note(x) for x in tonic] + [note(tonic[0] + 12)], DUR - hold, 0.05, 1.0), hold, 0.22)


# ---------- Sound effects ----------
def boing(p):
    t = t_axis(0.55)
    f = 180 * p * (0.75 + 0.6 * (1 - np.exp(-t * 14))) * (1 + 0.18 * np.sin(2 * np.pi * 16 * t) * np.exp(-t * 4))
    ph = glide(f)
    return (np.sin(ph) + 0.25 * np.sin(2 * ph)) * np.exp(-t * 5.5) * (1 - np.exp(-t * 600))


def pop(p):
    t = t_axis(0.13)
    return np.sin(glide(380 * p + 900 * p * np.exp(-t * 60))) * np.exp(-t * 38) + 0.25 * highpass(rng.standard_normal(len(t)), 2000) * np.exp(-t * 400)


def tick(p):
    t = t_axis(0.05)
    return np.sin(2 * np.pi * 2300 * p * t) * np.exp(-t * 110) * 0.8


def blip(p):
    t = t_axis(0.14)
    return np.sin(glide(500 * p + 900 * p * t / 0.14)) * np.exp(-t * 22)


def ding(p):
    out = np.zeros(int(SR * 0.5))
    for k, (f, at) in enumerate([(1320 * p, 0.0), (1760 * p, 0.07)]):
        t = t_axis(0.4)
        s = (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t * 12)) * np.exp(-t * 9) * (1 - np.exp(-t * 2000))
        i = int(SR * at)
        out[i : i + len(s)] += s * (0.8 if k else 1)
    return out


def slam():
    t = t_axis(0.35)
    return np.sin(glide(55 + 120 * np.exp(-t * 30))) * np.exp(-t * 12) + 0.6 * band(rng.standard_normal(len(t)), 300, 3000) * np.exp(-t * 45)


def breath():
    t = t_axis(1.4)
    return band(rng.standard_normal(len(t)), 400, 2400) * np.sin(np.pi * t / 1.4) ** 2 * 0.6


def bubble():
    t = t_axis(0.18)
    return np.sin(glide(280 + 700 * (1 - np.exp(-t * 45)))) * np.exp(-t * 20) * (1 - np.exp(-t * 800))


def whoosh(d):
    t = t_axis(d)
    noise = rng.standard_normal(len(t))
    centers = [300, 550, 900, 1500, 2400, 3800]
    pos = np.sin(np.pi * t / d) * (len(centers) - 1)
    out = sum(band(noise, c * 0.7, c * 1.4) * np.clip(1 - np.abs(pos - k), 0, 1) for k, c in enumerate(centers))
    return out * np.sin(np.pi * t / d) ** 1.5 * 2.2


def thud():
    t = t_axis(0.3)
    return np.sin(glide(45 + 70 * np.exp(-t * 25))) * np.exp(-t * 14) + band(rng.standard_normal(len(t)), 600, 2500) * np.exp(-t * 70) * 0.7


def sparkle(seed):
    r = np.random.default_rng(seed)
    out = np.zeros(int(SR * 0.7))
    for k in range(7):
        t = t_axis(0.35)
        s = np.sin(2 * np.pi * r.uniform(2200, 5200) * t) * np.exp(-t * 14) * 0.35
        i = int(SR * k * 0.035)
        out[i : i + len(s)] += s
    return out


def slide(f0, f1, d):
    t = t_axis(d)
    f = f0 * (f1 / f0) ** (t / d) * (1 + 0.02 * np.sin(2 * np.pi * 7 * t))
    return (np.sin(glide(f)) + band(rng.standard_normal(len(t)), 1500, 4000) * 0.05) * np.sin(np.pi * np.minimum(1, t / d)) ** 0.6


def tada():
    out = np.zeros(int(SR * 1.3))
    for s in [0, 4, 7, 12, 16]:
        m = marimba(note(C4 + 12 + s), 1.2) * 0.4
        out[: len(m)] += m
        t = t_axis(1.1)
        out[: len(t)] += lowpass(2 * ((note(C4 + s) * t) % 1) - 1, 2200) * np.exp(-t * 3) * (1 - np.exp(-t * 60)) * 0.22
    t = t_axis(1.3)
    return out + highpass(rng.standard_normal(len(t)), 5000) * np.exp(-t * 3.2) * 0.35


def load_audio(path):
    raw = subprocess.run([ffmpeg_path(), "-loglevel", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


speech = []
sfx_on = MUSIC.get("sfx", True)
for n, c in enumerate(CUES):
    kind, at, g = c["kind"], c["t"], c.get("gain", 1.0)
    pan = float(np.clip(rng.normal(0, 0.25), -0.6, 0.6))
    if kind == "voice":
        line = VOICES.get(c["key"], {})
        if line.get("file"):
            v = load_audio(os.path.join(PROJECT, line["file"]))
            place(voice, v / (np.max(np.abs(v)) + 1e-9) * 0.9, at, 1.0)
            speech.append((at + line["speechStart"], c["end"]))
        continue
    if not sfx_on:
        continue
    table = {
        "ding": lambda: (ding(c.get("pitch", 1)), 0.3),
        "slam": lambda: (slam(), 0.55),
        "breath": lambda: (breath(), 0.35),
        "boing": lambda: (boing(c.get("pitch", 1)), 0.45),
        "pop": lambda: (pop(c.get("pitch", 1)), 0.4),
        "tick": lambda: (tick(c.get("pitch", 1)), 0.35),
        "blip": lambda: (blip(c.get("pitch", 1)), 0.35),
        "bubble": lambda: (bubble(), 0.4),
        "thud": lambda: (thud(), 0.6),
        "sparkle": lambda: (sparkle(n), 0.45),
        "marimba": lambda: (marimba(note(C4 + c["semis"]), 0.5), 0.3),
        "slide": lambda: (slide(c["from"], c["to"], c["dur"]), 0.2),
        "tada": lambda: (tada(), 0.7),
        "roll": lambda: (clap(), 0.8),
    }
    if kind == "whoosh":
        d = c.get("dur", 0.4)
        place(sfx, whoosh(d), at - d * 0.3, 0.3 * g, pan)
    elif kind in table:
        sig, base = table[kind]()
        place(sfx, sig, at, base * g, 0 if kind in ("thud", "tada", "slam") else pan)
    else:
        print(f"unknown cue kind: {kind}")

# Duck the music (and a little of the effects) while anyone speaks.
tt = np.arange(N) / SR
duck = np.ones(N)
for s, e in speech:
    duck = np.minimum(duck, 1 - 0.6 * np.minimum(np.clip((tt - (s - 0.12)) / 0.12, 0, 1), np.clip(((e + 0.2) - tt) / 0.2, 0, 1)))
mixdown = music * MUSIC.get("volume", 0.55) * duck[:, None] + sfx * (0.55 + 0.45 * duck)[:, None] + voice

fade = np.ones(N)
n_fade = int(SR * min(0.8, DUR / 4))
fade[-n_fade:] = np.linspace(1, 0, n_fade)
mixdown *= fade[:, None]
mixdown = np.tanh(mixdown * 1.1) / np.tanh(1.1)
peak = np.max(np.abs(mixdown))
if peak > 0:
    mixdown *= 10 ** (-1 / 20) / peak
wavfile.write(os.path.join(BUILD, "soundtrack.wav"), SR, (mixdown * 32767).astype(np.int16))
print(f"› soundtrack.wav  {DUR:.2f}s  {len(speech)} voice line(s)  {len(CUES)} cues")
