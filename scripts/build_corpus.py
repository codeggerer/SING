#!/usr/bin/env python3
"""
Corpus Builder for Karaoke Engine Benchmark Harness.
Downloads 16 diverse songs (8 German, 8 English) covering male, female, rap-ish, fast, and slow styles,
and creates eval/corpus/<slug>/{audio.mp3,truth.txt}.
"""

import os
import sys
import json
import subprocess
import urllib.request
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))
from eval.ultrastar_parser import parse_ultrastar_txt

ALLKARAOKE_BASE = "https://raw.githubusercontent.com/Asvarox/allkaraoke/master/public/songs"

CORPUS_SONGS = [
    # German - Female
    {
        "slug": "2raumwohnung-36-grad",
        "artist": "2raumwohnung",
        "title": "36 Grad",
        "lang": "German",
        "gender": "Female",
        "style": "Pop / Dance",
        "tempo": "Moderate (BPM 252)",
        "video": "wIRyoh5TClI",
    },
    {
        "slug": "namika-je-ne-parle-pas-francais",
        "artist": "Namika",
        "title": "Je ne parle pas français",
        "lang": "German",
        "gender": "Female",
        "style": "Melodic Pop",
        "tempo": "Moderate (BPM 240)",
        "video": "103bx_Waacc",
    },
    {
        "slug": "sido-bilder-im-kopf",
        "artist": "Sido",
        "title": "Bilder im Kopf",
        "lang": "German",
        "gender": "Male",
        "style": "German Rap / Hip-Hop",
        "tempo": "Moderate (BPM 190)",
        "video": "RveIJFR7LV4",
    },
    {
        "slug": "nina-chuba-wildberry-lillet",
        "artist": "Nina Chuba",
        "title": "Wildberry Lillet",
        "lang": "German",
        "gender": "Female",
        "style": "Modern Hip-Hop / Pop",
        "tempo": "Moderate (BPM 280)",
        "video": "95xDIF5zYCo",
    },
    # German - Male
    {
        "slug": "peter-fox-haus-am-see",
        "artist": "Peter Fox",
        "title": "Haus am See",
        "lang": "German",
        "gender": "Male",
        "style": "Rhythmic Hip-Hop / Dancehall",
        "tempo": "Fast (BPM 384)",
        "video": "j-XKgB5guDQ",
    },
    {
        "slug": "cro-easy",
        "artist": "Cro",
        "title": "Easy",
        "lang": "German",
        "gender": "Male",
        "style": "Rap / Hip-Hop",
        "tempo": "Fast (BPM 381.5)",
        "video": "4wOoLLDXbDY",
    },
    {
        "slug": "apache-207-roller",
        "artist": "Apache 207",
        "title": "Roller",
        "lang": "German",
        "gender": "Male",
        "style": "Trap / Melodic Rap",
        "tempo": "Moderate (BPM 256)",
        "video": "Fo3DAhiNKQo",
    },
    {
        "slug": "die-arzte-schrei-nach-liebe",
        "artist": "Die Ärzte",
        "title": "Schrei nach Liebe",
        "lang": "German",
        "gender": "Male",
        "style": "Punk Rock",
        "tempo": "Fast (BPM 252)",
        "video": "6X9CEi8wkBc",
    },
    # English - Female
    {
        "slug": "adele-rolling-in-the-deep",
        "artist": "Adele",
        "title": "Rolling In The Deep",
        "lang": "English",
        "gender": "Female",
        "style": "Soul / Pop Ballad",
        "tempo": "Moderate (BPM 210)",
        "video": "rYEDA3JcQqw",
    },
    {
        "slug": "billie-eilish-bad-guy",
        "artist": "Billie Eilish",
        "title": "Bad Guy",
        "lang": "English",
        "gender": "Female",
        "style": "Whisper Pop / Dance-pop",
        "tempo": "Moderate (BPM 269.9)",
        "video": "DyDfgMOUjCI",
    },
    {
        "slug": "dua-lipa-dont-start-now",
        "artist": "Dua Lipa",
        "title": "Don't Start Now",
        "lang": "English",
        "gender": "Female",
        "style": "Nu-Disco / Dance Pop",
        "tempo": "Moderate (BPM 248)",
        "video": "oygrmJFKYZY",
    },
    {
        "slug": "sia-chandelier",
        "artist": "Sia",
        "title": "Chandelier",
        "lang": "English",
        "gender": "Female",
        "style": "Electropop Ballad / High Dynamic",
        "tempo": "Moderate (BPM 261)",
        "video": "2vjPBrBU-TM",
    },
    # English - Male
    {
        "slug": "eminem-without-me",
        "artist": "Eminem",
        "title": "Without Me",
        "lang": "English",
        "gender": "Male",
        "style": "Fast Rap / Hip-Hop",
        "tempo": "Fast (BPM 448)",
        "video": "YVkUvmDQ3HY",
    },
    {
        "slug": "queen-dont-stop-me-now",
        "artist": "Queen",
        "title": "Don't Stop Me Now",
        "lang": "English",
        "gender": "Male",
        "style": "Glam Rock / High Energy",
        "tempo": "Fast (BPM 308.8)",
        "video": "HgzGwKwLmgM",
    },
    {
        "slug": "ed-sheeran-perfect",
        "artist": "Ed Sheeran",
        "title": "Perfect",
        "lang": "English",
        "gender": "Male",
        "style": "Slow Acoustic Pop Ballad",
        "tempo": "Slow (BPM 232.2)",
        "video": "2Vv-BfVoq4g",
    },
    {
        "slug": "oasis-wonderwall",
        "artist": "Oasis",
        "title": "Wonderwall",
        "lang": "English",
        "gender": "Male",
        "style": "Britpop / Acoustic Rock",
        "tempo": "Moderate (BPM 348)",
        "video": "6hzrDeceEKc",
    },
]


def build_corpus(corpus_dir: Path = Path("eval/corpus")):
    corpus_dir.mkdir(parents=True, exist_ok=True)
    yt_dlp_bin = Path("venv/bin/yt-dlp")
    if not yt_dlp_bin.exists():
        yt_dlp_bin = "yt-dlp"

    success_count = 0
    total = len(CORPUS_SONGS)

    for idx, s in enumerate(CORPUS_SONGS, 1):
        slug = s["slug"]
        song_dir = corpus_dir / slug
        song_dir.mkdir(parents=True, exist_ok=True)
        truth_file = song_dir / "truth.txt"
        audio_file = song_dir / "audio.mp3"

        print(f"[{idx}/{total}] Processing {s['artist']} - {s['title']} ({slug})...")

        # 1. Download truth.txt if missing
        if not truth_file.exists() or truth_file.stat().st_size == 0:
            url = f"{ALLKARAOKE_BASE}/{slug}.txt"
            try:
                urllib.request.urlretrieve(url, truth_file)
                print(f"  ✓ Downloaded truth.txt ({truth_file.stat().st_size} bytes)")
            except Exception as e:
                print(f"  ✗ Failed to download truth.txt: {e}")
                continue

        # Verify truth file parses cleanly
        try:
            chart = parse_ultrastar_txt(truth_file)
            if len(chart.notes) < 10:
                print(f"  ✗ truth.txt has too few notes ({len(chart.notes)})")
                continue
        except Exception as e:
            print(f"  ✗ Failed to parse truth.txt: {e}")
            continue

        # 2. Download audio if missing
        if not audio_file.exists() or audio_file.stat().st_size == 0:
            yt_url = f"https://www.youtube.com/watch?v={s['video']}"
            cmd = [
                str(yt_dlp_bin),
                "-x",
                "--audio-format", "mp3",
                "-o", str(song_dir / "audio.%(ext)s"),
                yt_url,
            ]
            try:
                res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120)
                if res.returncode != 0:
                    print(f"  ✗ yt-dlp error: {res.stderr.strip()[:200]}")
                    continue
                print(f"  ✓ Downloaded audio.mp3 ({audio_file.stat().st_size} bytes)")
            except Exception as e:
                print(f"  ✗ yt-dlp failed: {e}")
                continue
        else:
            print(f"  ✓ audio.mp3 already exists ({audio_file.stat().st_size} bytes)")

        success_count += 1

    print(f"\nFinished! {success_count}/{total} songs ready in corpus.")
    generate_readme(corpus_dir)


def generate_readme(corpus_dir: Path):
    lines = [
        "# 🎶 Evaluation Corpus (16 Benchmark Songs)",
        "",
        "This corpus provides a diverse, balanced ground truth dataset for evaluating the AI Karaoke Engine across pitch accuracy, lyrics WER/CER, syllable onset/duration errors, and false split rates.",
        "",
        "## Distribution Matrix",
        "- **Languages:** 8 German (50%), 8 English (50%)",
        "- **Genders:** 8 Female (50%), 8 Male (50%)",
        "- **Genres & Styles:** Rap/Hip-hop, Pop, Rock, Soul, Electro, Punk, Acoustic Ballads",
        "- **Tempos:** Slow (BPM ~230) to Ultra-fast (BPM 448)",
        "",
        "## Song Catalog",
        "",
        "| Slug | Artist & Title | Language | Gender | Style | Notes |",
        "| :--- | :--- | :--- | :--- | :--- | :--- |",
    ]
    for s in CORPUS_SONGS:
        slug = s["slug"]
        song_dir = corpus_dir / slug
        truth_file = song_dir / "truth.txt"
        note_count = "?"
        if truth_file.exists():
            try:
                c = parse_ultrastar_txt(truth_file)
                note_count = str(len(c.notes))
            except Exception:
                pass
        lines.append(
            f"| `{s['slug']}` | **{s['artist']}** – *{s['title']}* | {s['lang']} | {s['gender']} | {s['style']} ({s['tempo']}) | {note_count} |"
        )
    lines.append("")
    readme_path = corpus_dir / "README.md"
    readme_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote corpus documentation to {readme_path}")


if __name__ == "__main__":
    build_corpus()
