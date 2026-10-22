#!/usr/bin/env python3
"""
Evaluation Harness for AI Karaoke Generator (PLAN.md Phase 1).

Measures:
- Pitch accuracy (strict ±0, ±1 semitones, and octave-agnostic mod 12)
- Onset error (median and P90 absolute ms error via monotone DTW)
- Duration error (median relative error)
- Lyrics accuracy (WER and CER on normalized text)
- False split rate (share of truth syllables matched by >1 generated note)

Outputs results to console table and eval/results/<git-sha>.json (or baseline.json).
"""

from __future__ import annotations
import os
import sys
import glob
import json
import time
import shutil
import argparse
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, List, Optional

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from eval.ultrastar_parser import parse_ultrastar_txt, UltraStarChart
from eval.metrics import evaluate_chart, EvalMetrics


def get_git_sha() -> str:
    """Get the current short git commit SHA."""
    try:
        res = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            check=True,
        )
        return res.stdout.strip()
    except Exception:
        return "unknown"


def get_source_code_mtime() -> float:
    """Return the most recent modification timestamp among core engine source files."""
    source_files: List[Path] = []

    karaoke_dir = PROJECT_ROOT / "karaoke"
    if karaoke_dir.exists():
        for p in karaoke_dir.rglob("*.py"):
            if not p.name.startswith(".") and "__pycache__" not in p.parts:
                source_files.append(p)

    gk_file = PROJECT_ROOT / "generate_karaoke.py"
    if gk_file.exists():
        source_files.append(gk_file)

    lp_dir = PROJECT_ROOT / "lyrics_providers"
    if lp_dir.exists():
        for p in lp_dir.rglob("*.py"):
            if not p.name.startswith(".") and "__pycache__" not in p.parts:
                source_files.append(p)

    if not source_files:
        return 0.0
    return max(f.stat().st_mtime for f in source_files if f.is_file())


def is_chart_cache_valid(
    gen_txt_path: Path,
    meta_path: Path,
    mode: str,
    pitch_engine: str,
    separator: str,
    use_basic_pitch: bool,
    source_mtime: float,
) -> bool:
    """
    Check if a generated chart is valid:
    - Exists on disk
    - File modification time >= source_mtime
    - Companion .meta.json exists and matches mode, pitch_engine, separator, use_basic_pitch, and source_mtime >= source_mtime
    """
    if not gen_txt_path.exists():
        return False
    if gen_txt_path.stat().st_mtime < source_mtime:
        return False
    if not meta_path.exists():
        return False
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
        if meta.get("mode") != mode:
            return False
        if meta.get("pitch_engine") != pitch_engine:
            return False
        if meta.get("separator") != separator:
            return False
        if meta.get("use_basic_pitch") != use_basic_pitch:
            return False
        if meta.get("source_mtime", 0) < source_mtime:
            return False
        return True
    except Exception:
        return False


def run_pipeline_on_song(
    audio_path: Path,
    output_dir: Path,
    pitch_engine: str = "fcpe",
    separator: str = "demucs",
    use_basic_pitch: bool = False,
    inject_truth_chart: Optional[UltraStarChart] = None,
    lyrics_json_path: Optional[Path] = None,
    output_txt: Optional[Path] = None,
) -> Path:
    """
    Run generate_karaoke.py on a song.
    If inject_truth_chart is provided, uses truth timings/lyrics to isolate pitch evaluation.
    If lyrics_json_path is provided, uses canonical lyrics document (Phase 2).
    Returns path to generated UltraStar .txt file.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    import generate_karaoke as gk
    from lyrics_providers import LyricsDoc

    # Step 1: Vocal separation (cached if already present)
    vocals_file, instrumental_file = gk.separate_stems(audio_path, output_dir=output_dir, separator=separator)

    # Step 2: Pitch tracking
    pitch_data = gk.analyze_vocal_pitch(vocals_file, pitch_engine=pitch_engine)

    # Step 3: Key detection
    key_info = gk.detect_song_key(
        instrumental_file if instrumental_file.exists() else audio_path,
        vocal_path=vocals_file,
    )

    # Optional Basic Pitch note prediction
    bp_notes = None
    if use_basic_pitch:
        bp_adapter = gk.BasicPitchAdapter()
        if bp_adapter.is_available:
            bp_notes = bp_adapter.predict_notes(vocals_file)

    if output_txt is None:
        output_txt = output_dir / f"{audio_path.stem}.txt"

    if inject_truth_chart:
        # Isolate pitch: use truth syllables and timings
        truth_words = []
        for n in inject_truth_chart.notes:
            truth_words.append({
                "word": n.text,
                "start": n.start_sec,
                "end": n.end_sec,
                "confidence": 1.0,
            })
        lang = inject_truth_chart.headers.get("LANGUAGE", "en").lower()[:2]
        gk.generate_ultrastar_chart(
            truth_words,
            pitch_data,
            120,
            inject_truth_chart.title or audio_path.stem,
            inject_truth_chart.artist or "Truth",
            output_txt,
            lang=lang,
            key_info=key_info,
            basic_pitch_notes=bp_notes,
        )
    elif lyrics_json_path and lyrics_json_path.exists():
        # Phase 2 & 4: Canonical lyrics doc with MMS forced alignment & audio snapping
        from karaoke.lyrics_io import load_canonical_lyrics
        res = load_canonical_lyrics(
            lyrics_json_path,
            vocals_file,
            pitch_data=pitch_data,
        )
        if res is not None:
            words, lang = res
        else:
            words, lang = gk.transcribe_lyrics(vocals_file, pitch_data=pitch_data)

        gk.generate_ultrastar_chart(
            words,
            pitch_data,
            120,
            audio_path.stem,
            "Unknown Artist",
            output_txt,
            lang=lang,
            key_info=key_info,
            basic_pitch_notes=bp_notes,
        )
    else:
        # Full fallback: Whisper transcription + Phase 4 MMS forced alignment
        words, detected_lang = gk.transcribe_lyrics(vocals_file, pitch_data=pitch_data)
        gk.generate_ultrastar_chart(
            words,
            pitch_data,
            120,
            audio_path.stem,
            "Unknown Artist",
            output_txt,
            lang=detected_lang,
            key_info=key_info,
            basic_pitch_notes=bp_notes,
        )

    return output_txt


def format_table(rows: List[List[str]], headers: List[str]) -> str:
    """Format tabular data into a readable aligned text table."""
    col_widths = [len(h) for h in headers]
    for row in rows:
        for idx, cell in enumerate(row):
            col_widths[idx] = max(col_widths[idx], len(str(cell)))

    sep = "+-" + "-+-".join("-" * w for w in col_widths) + "-+"
    header_str = "| " + " | ".join(h.ljust(col_widths[i]) for i, h in enumerate(headers)) + " |"

    body_lines = []
    for r in rows:
        line = "| " + " | ".join(str(c).ljust(col_widths[i]) for i, c in enumerate(r)) + " |"
        body_lines.append(line)

    return "\n".join([sep, header_str, sep] + body_lines + [sep])


def evaluate_corpus(
    stage: str = "all",
    songs_pattern: str = "*",
    corpus_dir: Path = Path("eval/corpus"),
    results_dir: Path = Path("eval/results"),
    save_as: Optional[str] = None,
    pitch_engine: str = "fcpe",
    separator: str = "demucs",
    use_basic_pitch: bool = False,
    inject_truth_lyrics: bool = False,
    force: bool = False,
    use_lyrics_doc: bool = True,
    check_regression: Optional[str] = None,
    mode: str = "canonical",
    anchor_octave: bool = True,
) -> Dict[str, Any]:
    """
    Run evaluation on selected corpus songs and report results.
    """
    corpus_dir = corpus_dir.resolve()
    results_dir.mkdir(parents=True, exist_ok=True)

    # Normalize mode handling with legacy flags
    if mode == "truth" or inject_truth_lyrics or stage == "pitch":
        mode = "truth"
    elif not use_lyrics_doc or mode == "whisper":
        mode = "whisper"
    elif mode not in ("whisper", "canonical", "truth"):
        mode = "canonical"

    source_mtime = get_source_code_mtime()

    # Find matching song directories
    candidate_dirs = [
        d for d in corpus_dir.iterdir()
        if d.is_dir() and (d / "truth.txt").exists() and (d / "audio.mp3").exists()
    ]
    candidate_dirs.sort(key=lambda p: p.name)

    # Filter by pattern
    FAST_SUBSET = ["2raumwohnung-36-grad", "cro-easy", "queen-dont-stop-me-now"]
    matched_dirs = []

    if songs_pattern in ("fast/*", "fast", "fast/"):
        matched_dirs = [d for d in candidate_dirs if d.name in FAST_SUBSET]
    else:
        import fnmatch
        for d in candidate_dirs:
            if songs_pattern == "*" or fnmatch.fnmatch(d.name, songs_pattern) or songs_pattern in d.name:
                matched_dirs.append(d)

    if not matched_dirs:
        print(f"⚠️  No corpus songs matching pattern '{songs_pattern}' found in {corpus_dir}")
        return {}

    bp_flag = " + BasicPitch" if use_basic_pitch else ""
    print(f"\n🎯 Running evaluation [mode: {mode}, stage: {stage}, pitch_engine: {pitch_engine}{bp_flag}, separator: {separator}] on {len(matched_dirs)} song(s)...\n")

    results_by_song: Dict[str, Any] = {}
    table_rows: List[List[str]] = []

    for d in matched_dirs:
        slug = d.name
        truth_path = d / "truth.txt"
        audio_path = d / "audio.mp3"

        truth_chart = parse_ultrastar_txt(truth_path)

        out_gen_dir = PROJECT_ROOT / "output" / "eval" / slug
        gen_txt_path = out_gen_dir / f"{audio_path.stem}_{mode}.txt"
        meta_path = out_gen_dir / f"{audio_path.stem}_{mode}.meta.json"
        legacy_txt_path = out_gen_dir / f"{audio_path.stem}.txt"

        cache_valid = False
        target_txt = gen_txt_path

        if not force:
            if is_chart_cache_valid(gen_txt_path, meta_path, mode, pitch_engine, separator, use_basic_pitch, source_mtime):
                cache_valid = True
                target_txt = gen_txt_path
            elif mode == "canonical" and legacy_txt_path.exists() and legacy_txt_path.stat().st_mtime >= source_mtime:
                cache_valid = True
                target_txt = legacy_txt_path

        t0 = time.time()
        # Run generation if needed
        if not cache_valid:
            print(f"▶ Generating chart for {slug} [mode: {mode}]...")
            inject_chart = truth_chart if mode == "truth" else None
            lyrics_json = (d / "lyrics.json") if (mode == "canonical" and (d / "lyrics.json").exists()) else None
            try:
                target_txt = run_pipeline_on_song(
                    audio_path,
                    out_gen_dir,
                    pitch_engine=pitch_engine,
                    separator=separator,
                    use_basic_pitch=use_basic_pitch,
                    inject_truth_chart=inject_chart,
                    lyrics_json_path=lyrics_json,
                    output_txt=gen_txt_path,
                )
                try:
                    shutil.copy2(target_txt, legacy_txt_path)
                except Exception:
                    pass

                meta_data = {
                    "mode": mode,
                    "pitch_engine": pitch_engine,
                    "separator": separator,
                    "use_basic_pitch": use_basic_pitch,
                    "source_mtime": source_mtime,
                    "generated_at": datetime.now().isoformat(),
                }
                with open(meta_path, "w", encoding="utf-8") as f:
                    json.dump(meta_data, f, indent=2)

            except Exception as e:
                print(f"  ✗ Failed to generate for {slug}: {e}")
                continue

        gen_time = round(time.time() - t0, 1)

        # Parse generated chart
        try:
            gen_chart = parse_ultrastar_txt(target_txt)
        except Exception as e:
            print(f"  ✗ Failed to parse generated chart {target_txt}: {e}")
            continue

        # Evaluate metrics
        metrics = evaluate_chart(
            truth_chart.notes_dict,
            gen_chart.notes_dict,
            anchor_octave=anchor_octave,
        )
        m_dict = metrics.to_dict()

        results_by_song[slug] = {
            "title": truth_chart.title,
            "artist": truth_chart.artist,
            "metrics": m_dict,
            "runtime_sec": gen_time,
        }

        # Build table row
        table_rows.append([
            slug[:25],
            f"{m_dict['pitch_strict_0'] * 100:.1f}%",
            f"{m_dict['pitch_strict_1'] * 100:.1f}%",
            f"{m_dict['pitch_octave_1'] * 100:.1f}%",
            f"{m_dict['onset_error_median_ms']:.0f}ms",
            f"{m_dict['onset_error_p90_ms']:.0f}ms",
            f"{m_dict['duration_error_median']:.2f}",
            f"{m_dict['lyrics_wer'] * 100:.1f}%",
            f"{m_dict['lyrics_cer'] * 100:.1f}%",
            f"{m_dict['false_split_rate'] * 100:.1f}%",
        ])

    if not results_by_song:
        print("No evaluation results were produced.")
        return {}

    # Calculate summary / aggregates
    all_metrics = [v["metrics"] for v in results_by_song.values()]
    n = len(all_metrics)

    mean_strict_0 = sum(m["pitch_strict_0"] for m in all_metrics) / n
    mean_strict_1 = sum(m["pitch_strict_1"] for m in all_metrics) / n
    mean_octave_1 = sum(m["pitch_octave_1"] for m in all_metrics) / n
    median_onsets = sorted(m["onset_error_median_ms"] for m in all_metrics)
    summary_onset_med = median_onsets[n // 2]
    median_p90s = sorted(m["onset_error_p90_ms"] for m in all_metrics)
    summary_onset_p90 = median_p90s[n // 2]
    median_durs = sorted(m["duration_error_median"] for m in all_metrics)
    summary_dur_med = median_durs[n // 2]
    mean_wer = sum(m["lyrics_wer"] for m in all_metrics) / n
    mean_cer = sum(m["lyrics_cer"] for m in all_metrics) / n
    mean_splits = sum(m["false_split_rate"] for m in all_metrics) / n

    # Add summary row
    table_rows.append([
        "** OVERALL MEAN/MED **",
        f"{mean_strict_0 * 100:.1f}%",
        f"{mean_strict_1 * 100:.1f}%",
        f"{mean_octave_1 * 100:.1f}%",
        f"{summary_onset_med:.0f}ms",
        f"{summary_onset_p90:.0f}ms",
        f"{summary_dur_med:.2f}",
        f"{mean_wer * 100:.1f}%",
        f"{mean_cer * 100:.1f}%",
        f"{mean_splits * 100:.1f}%",
    ])

    headers = [
        "Song",
        "Pitch ±0",
        "Pitch ±1",
        "Octave ±1",
        "Onset Med",
        "Onset P90",
        "Dur Rel",
        "WER",
        "CER",
        "Split Rate",
    ]
    print(format_table(table_rows, headers))

    git_sha = get_git_sha()
    summary = {
        "mean_pitch_strict_0": round(mean_strict_0, 4),
        "mean_pitch_strict_1": round(mean_strict_1, 4),
        "mean_pitch_octave_1": round(mean_octave_1, 4),
        "median_onset_error_ms": round(summary_onset_med, 2),
        "median_onset_error_p90_ms": round(summary_onset_p90, 2),
        "median_duration_error": round(summary_dur_med, 4),
        "mean_lyrics_wer": round(mean_wer, 4),
        "mean_lyrics_cer": round(mean_cer, 4),
        "mean_false_split_rate": round(mean_splits, 4),
        "total_songs": n,
    }

    full_report = {
        "timestamp": datetime.now().isoformat(),
        "git_sha": git_sha,
        "mode": mode,
        "stage": stage,
        "pitch_engine": pitch_engine,
        "inject_truth_lyrics": (mode == "truth"),
        "summary": summary,
        "songs": results_by_song,
    }

    # Save output JSON
    if save_as:
        filename = save_as if save_as.endswith(".json") else f"{save_as}.json"
        out_file = results_dir / filename
    else:
        out_file = results_dir / f"{git_sha}.json"

    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(full_report, f, indent=2, ensure_ascii=False)

    print(f"\n📊 Evaluation results saved to: {out_file}\n")

    # Regression Gate Verification (PLAN.md Phase 7.4)
    if check_regression:
        baseline_file = Path(check_regression)
        if not baseline_file.is_absolute():
            baseline_file = PROJECT_ROOT / baseline_file
        if not baseline_file.exists():
            print(f"⚠️ Regression gate baseline file not found: {baseline_file}")
            sys.exit(1)

        with open(baseline_file, "r", encoding="utf-8") as f:
            base_data = json.load(f)

        regressions = []
        for song_slug, song_res in results_by_song.items():
            if song_slug not in base_data.get("songs", {}):
                continue
            base_m = base_data["songs"][song_slug]["metrics"]
            cur_m = song_res["metrics"]

            # 1. Pitch octave_1 (higher is better): must not drop by > 2 percentage points (0.02)
            if base_m.get("pitch_octave_1") is not None and cur_m.get("pitch_octave_1") is not None:
                drop = base_m["pitch_octave_1"] - cur_m["pitch_octave_1"]
                if drop > 0.02:
                    regressions.append(
                        f"{song_slug}: Octave ±1 pitch accuracy dropped by {drop*100:.1f}% "
                        f"({base_m['pitch_octave_1']*100:.1f}% -> {cur_m['pitch_octave_1']*100:.1f}%)"
                    )

            # 2. False split rate (lower is better): must not increase by > 2 percentage points (0.02)
            if base_m.get("false_split_rate") is not None and cur_m.get("false_split_rate") is not None:
                increase = cur_m["false_split_rate"] - base_m["false_split_rate"]
                if increase > 0.02:
                    regressions.append(
                        f"{song_slug}: False split rate increased by {increase*100:.1f}% "
                        f"({base_m['false_split_rate']*100:.1f}% -> {cur_m['false_split_rate']*100:.1f}%)"
                    )

            # 3. CER (lower is better): must not increase by > 2 percentage points (0.02)
            if base_m.get("lyrics_cer") is not None and cur_m.get("lyrics_cer") is not None:
                cer_increase = cur_m["lyrics_cer"] - base_m["lyrics_cer"]
                if cer_increase > 0.02:
                    regressions.append(
                        f"{song_slug}: Lyrics CER increased by {cer_increase*100:.1f}% "
                        f"({base_m['lyrics_cer']*100:.1f}% -> {cur_m['lyrics_cer']*100:.1f}%)"
                    )

        if regressions:
            print("❌ REGRESSION GATE FAILED (Metrics regressed by > 2 points against baseline):")
            for r in regressions:
                print(f"  - {r}")
            sys.exit(1)
        else:
            print("✅ REGRESSION GATE PASSED: All metrics within 2.0% of baseline!")

    return full_report


def main():
    parser = argparse.ArgumentParser(description="Evaluate AI Karaoke Engine against Ground Truth Corpus")
    parser.add_argument(
        "--mode",
        choices=["whisper", "canonical", "truth"],
        default="canonical",
        help="Evaluation mode: 'canonical' (lyrics.json), 'whisper' (pure AI fallback), 'truth' (inject truth syllables) (default: canonical)",
    )
    parser.add_argument(
        "--stage",
        choices=["pitch", "lyrics", "timing", "all"],
        default="all",
        help="Stage to evaluate (default: all)",
    )
    parser.add_argument(
        "--songs",
        default="*",
        help="Glob pattern or substring for songs to evaluate (default: *)",
    )
    parser.add_argument(
        "--corpus-dir",
        default="eval/corpus",
        help="Path to evaluation corpus directory",
    )
    parser.add_argument(
        "--results-dir",
        default="eval/results",
        help="Directory to save evaluation reports",
    )
    parser.add_argument(
        "--save-as",
        default=None,
        help="Explicit filename to save report (e.g. baseline.json)",
    )
    parser.add_argument(
        "--pitch-engine",
        choices=["fcpe", "crepe", "pyin", "rmvpe"],
        default="fcpe",
        help="Pitch engine to test (default: fcpe)",
    )
    parser.add_argument(
        "--separator",
        choices=["demucs", "roformer"],
        default="demucs",
        help="Separator model (default: demucs)",
    )
    parser.add_argument(
        "--use-basic-pitch",
        action="store_true",
        help="Enable Basic Pitch second opinion for melisma splits and octave tie-breaking",
    )
    parser.add_argument(
        "--inject-truth-lyrics",
        action="store_true",
        help="Inject truth lyrics and timing when testing pitch in isolation (deprecated, use --mode truth)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force re-generation of charts even if already cached",
    )
    parser.add_argument(
        "--no-lyrics",
        action="store_true",
        help="Ignore lyrics.json and force Whisper transcription (deprecated, use --mode whisper)",
    )
    parser.add_argument(
        "--check-regression",
        default=None,
        help="Path to baseline.json to verify no metric regressed by > 2 points (exit 1 on failure)",
    )
    parser.add_argument(
        "--no-octave-anchor",
        dest="anchor_octave",
        action="store_false",
        default=True,
        help="Disable octave anchoring during pitch evaluation",
    )
    args = parser.parse_args()

    mode = args.mode
    if args.no_lyrics:
        mode = "whisper"
    elif args.inject_truth_lyrics or args.stage == "pitch":
        mode = "truth"

    evaluate_corpus(
        stage=args.stage,
        songs_pattern=args.songs,
        corpus_dir=Path(args.corpus_dir),
        results_dir=Path(args.results_dir),
        save_as=args.save_as,
        pitch_engine=args.pitch_engine,
        separator=args.separator,
        use_basic_pitch=args.use_basic_pitch,
        inject_truth_lyrics=(mode == "truth"),
        force=args.force,
        use_lyrics_doc=(mode == "canonical"),
        check_regression=args.check_regression,
        mode=mode,
        anchor_octave=args.anchor_octave,
    )


if __name__ == "__main__":
    main()
