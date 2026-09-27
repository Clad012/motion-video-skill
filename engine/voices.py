"""Voice lines for a motion-video project.

    python engine/voices.py <project>                  generate missing/changed lines
    python engine/voices.py <project> --force          regenerate every line
    python engine/voices.py <project> --list           list the voices on your ElevenLabs account
    python engine/voices.py <project> --check-lines    transcribe each line and compare with its text
    python engine/voices.py <project> --check <audio>  transcribe a mix (e.g. build/soundtrack.wav)

Lines come from every scene with a "voice" in story.json. They are saved to
<project>/voices/<scene>.mp3 with word timings in <project>/voices/voices.json,
so a project with committed voices renders without an API key.

Without ELEVENLABS_API_KEY the script writes estimated word timings instead
(no audio): the whole video still syncs, it is just silent where voices go.
The key is read from the environment, or from a .env / .env.local file in the
project or repository folder.
"""
import base64
import difflib
import json
import os
import re
import sys
import urllib.error
import urllib.request

API = "https://api.elevenlabs.io"
HERE = os.path.dirname(os.path.abspath(__file__))


def load_key(project):
    if os.environ.get("ELEVENLABS_API_KEY"):
        return os.environ["ELEVENLABS_API_KEY"]
    for folder in (project, os.path.dirname(HERE), os.getcwd()):
        for name in (".env.local", ".env"):
            path = os.path.join(folder, name)
            if os.path.exists(path):
                for line in open(path, encoding="utf8"):
                    if line.strip().startswith("ELEVENLABS_API_KEY="):
                        return line.split("=", 1)[1].strip().strip("\"'")
    return None


def request(key, path, body=None, form=None):
    headers = {"xi-api-key": key}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if form is not None:
        boundary = "----motionvideo"
        parts = []
        for name, value in form.items():
            if isinstance(value, tuple):
                filename, content = value
                parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode() + content + b"\r\n")
            else:
                parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
        data = b"".join(parts) + f"--{boundary}--\r\n".encode()
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    req = urllib.request.Request(API + path, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"ElevenLabs {path} failed ({e.code}): {e.read()[:400]!r}")


WORD = re.compile(r"\[[^\]]*\]|[\w'’-]+", re.UNICODE)


def spoken_words(text):
    """The words of a line, without audio tags like [excited]."""
    return [m.group() for m in WORD.finditer(text) if not m.group().startswith("[")]


def words_from_alignment(alignment):
    chars = alignment["characters"]
    starts = alignment["character_start_times_seconds"]
    ends = alignment["character_end_times_seconds"]
    text = "".join(chars)
    out = []
    for m in WORD.finditer(text):
        if m.group().startswith("["):
            continue
        out.append({"w": m.group(), "start": round(starts[m.start()], 3), "end": round(ends[m.end() - 1], 3)})
    return out


def estimated_words(text):
    """Timings for a line nobody has recorded yet: about 2.7 words per second."""
    t, out = 0.0, []
    for m in WORD.finditer(text):
        w = m.group()
        if w.startswith("["):
            continue
        d = max(0.18, 0.06 * len(w) + 0.12)
        out.append({"w": w, "start": round(t, 3), "end": round(t + d, 3)})
        t += d + 0.06
        after = text[m.end() : m.end() + 1]
        if after in ".!?…":
            t += 0.3
        elif after in ",;:":
            t += 0.15
    return out


def scene_lines(story):
    for i, sc in enumerate(story["scenes"]):
        if sc.get("voice"):
            yield sc.get("id") or f"s{i + 1}", sc["voice"]


def generate(project, story, force):
    if not any(True for _ in scene_lines(story)):
        print("no scene has a voice: nothing to generate")
        return
    key = load_key(project)
    folder = os.path.join(project, "voices")
    os.makedirs(folder, exist_ok=True)
    index_path = os.path.join(folder, "voices.json")
    index = json.load(open(index_path, encoding="utf8")) if os.path.exists(index_path) else {}
    cfg = story.get("voiceSettings", {})
    model = cfg.get("model", "eleven_v3")
    language = story.get("language")
    cast = story.get("voices", {})
    fresh = {}
    for scene_key, voice in scene_lines(story):
        who = voice.get("who", "narrator")
        voice_id = cast.get(who)
        text = voice["text"]
        old = index.get(scene_key)
        mp3 = os.path.join(folder, f"{scene_key}.mp3")
        unchanged = old and old.get("text") == text and old.get("voiceId") == voice_id and old.get("model") == model
        if unchanged and not force and (old.get("synthetic") or os.path.exists(mp3)) and not (old.get("synthetic") and key and voice_id):
            fresh[scene_key] = old
            continue
        if not key or not voice_id:
            reason = "no ELEVENLABS_API_KEY" if not key else f'no voice id for "{who}" in story.voices'
            words = estimated_words(text)
            fresh[scene_key] = {"text": text, "who": who, "voiceId": voice_id, "model": model, "synthetic": True, "speechStart": 0.0, "speechEnd": words[-1]["end"] if words else 0.5, "words": words}
            print(f"  {scene_key}: estimated timings ({reason})")
            continue
        body = {"text": text, "model_id": model, "voice_settings": {"stability": cfg.get("stability", 0.5), "similarity_boost": cfg.get("similarity", 0.8)}}
        if language:
            body["language_code"] = language
        res = request(key, f"/v1/text-to-speech/{voice_id}/with-timestamps?output_format=mp3_44100_128", body)
        open(mp3, "wb").write(base64.b64decode(res["audio_base64"]))
        words = words_from_alignment(res["alignment"])
        if not words:
            raise SystemExit(f"{scene_key}: no words in the alignment; is the text empty?")
        fresh[scene_key] = {"text": text, "who": who, "voiceId": voice_id, "model": model, "file": f"voices/{scene_key}.mp3", "speechStart": words[0]["start"], "speechEnd": words[-1]["end"], "words": words}
        print(f"  {scene_key}: {who} {words[-1]['end'] - words[0]['start']:.2f}s  “{' '.join(w['w'] for w in words)}”")
    json.dump(fresh, open(index_path, "w", encoding="utf8"), ensure_ascii=False, indent=1)
    print(f"voices.json: {len(fresh)} line(s)")


def transcribe(key, path, language):
    form = {"model_id": "scribe_v1", "file": (os.path.basename(path), open(path, "rb").read())}
    if language:
        form["language_code"] = language
    return request(key, "/v1/speech-to-text", form=form)


def norm_words(s):
    return [w.lower().strip("'’-") for w in spoken_words(s)]


def similarity(a, b):
    return difflib.SequenceMatcher(None, norm_words(a), norm_words(b)).ratio()


def check_lines(project, story):
    key = load_key(project) or sys.exit("ELEVENLABS_API_KEY needed for --check-lines")
    index = json.load(open(os.path.join(project, "voices", "voices.json"), encoding="utf8"))
    bad = 0
    for scene_key, line in index.items():
        if line.get("synthetic"):
            print(f"  {scene_key}: (estimated, no audio)")
            continue
        heard = transcribe(key, os.path.join(project, line["file"]), story.get("language")).get("text", "")
        score = similarity(line["text"], heard)
        flag = "OK   " if score >= 0.85 else "CHECK"
        bad += score < 0.85
        print(f"  {flag} {scene_key}  {score:.2f}\n        wrote: {line['text']}\n        heard: {heard}")
    print(f"{bad} line(s) to check" if bad else "all lines match")


def check_mix(project, story, audio):
    key = load_key(project) or sys.exit("ELEVENLABS_API_KEY needed for --check")
    res = transcribe(key, audio, story.get("language"))
    words = [w for w in res.get("words", []) if w.get("type") == "word"]
    print("heard in the mix:")
    line, start = [], None
    for w in words:
        start = w["start"] if start is None else start
        line.append(w["text"])
        if w["text"].endswith((".", "?", "!")):
            print(f"  {start:6.2f}s  {' '.join(line)}")
            line, start = [], None
    if line:
        print(f"  {start:6.2f}s  {' '.join(line)}")
    heard = " ".join(w["text"] for w in words)
    print("expected lines:")
    for scene_key, voice in scene_lines(story):
        n = len(spoken_words(voice["text"]))
        best = max((similarity(voice["text"], " ".join(heard.split()[i : i + n])) for i in range(max(1, len(heard.split())))), default=0)
        print(f"  {'OK   ' if best >= 0.8 else 'CHECK'} {scene_key}  {best:.2f}  {voice['text']}")


def list_voices(project):
    key = load_key(project) or sys.exit("ELEVENLABS_API_KEY needed for --list")
    for category in ("premade", None):
        q = "?page_size=100" + (f"&category={category}" if category else "")
        for v in request(key, "/v2/voices" + q).get("voices", []):
            if category is None and v.get("category") == "premade":
                continue
            lab = v.get("labels", {})
            print(f"{v['voice_id']}  {v['name'][:44]:44}  {lab.get('gender', '')} {lab.get('age', '')} {lab.get('accent', '')} {v.get('category', '')}")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    project = os.path.abspath(sys.argv[1])
    story = json.load(open(os.path.join(project, "story.json"), encoding="utf8"))
    opts = sys.argv[2:]
    if "--list" in opts:
        list_voices(project)
    elif "--check-lines" in opts:
        check_lines(project, story)
    elif "--check" in opts:
        check_mix(project, story, opts[opts.index("--check") + 1])
    else:
        generate(project, story, "--force" in opts)


if __name__ == "__main__":
    main()
