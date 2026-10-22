#!/usr/bin/env python3
"""
scripts/align_audio_gap.py - CLI wrapper for FFT Acoustic Cross-Correlation Alignment.
MASTER_OVERHAUL_PLAN Phase 2.

Usage:
  # Align YouTube audio to Reference studio audio:
  python scripts/align_audio_gap.py yt_audio.wav studio_audio.wav --chart song.txt --update-chart --output-json

  # Align YouTube audio to UltraStar chart melody (when no studio audio is available):
  python scripts/align_audio_gap.py yt_audio.wav --chart song.txt --update-chart --output-json
"""

import sys
import json
import argparse
from pathlib import Path

# Add project root to sys.path so 'karaoke' package is importable
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from karaoke.sync import align_audio_gap, SyncResult, measure_studio_offset


def main():
    parser = argparse.ArgumentParser(
        description="FFT Acoustic Cross-Correlation Alignment for YouTube #GAP Synchronization (Phase 2)"
    )
    parser.add_argument("yt_audio", nargs="?", default=None, help="Path to YouTube audio file (WAV/MP3/M4A)")
    parser.add_argument("ref_audio", nargs="?", default=None, help="Path to Reference studio audio file (optional if --chart provided)")
    parser.add_argument("--yt-audio", dest="opt_yt_audio", default=None, help="Explicit path to YouTube audio file")
    parser.add_argument("--ref-audio", dest="opt_ref_audio", default=None, help="Explicit path to Reference audio file")
    parser.add_argument("--vocals-audio", "--vocals", dest="vocals_audio", default=None, help="Path to Demucs vocals.wav stem for onset alignment")
    parser.add_argument("--chart", default=None, help="Path to UltraStar .txt score chart file")
    parser.add_argument("--lyrics-json", default=None, help="Path to lyrics.json for studio offset measurement (Phase 2.2)")
    parser.add_argument("--measure-studio-offset", action="store_true", default=False,
                        help="Measure studio vs live offset (offset = t_vocal_first - t_lyric_first)")
    parser.add_argument("--chart-gap", type=float, default=None, help="Initial chart gap in milliseconds (overrides #GAP from file)")
    parser.add_argument("--update-chart", action="store_true", default=False, help="Update #GAP directly in the chart file")
    parser.add_argument("--out-chart", default=None, help="Output path for updated chart (if not overwriting in place)")
    parser.add_argument("--method", choices=["hybrid", "chroma", "gcc_phat", "onset", "vocal_onset"], default="hybrid",
                        help="Cross-correlation algorithm (default: hybrid)")
    parser.add_argument("--max-duration", type=float, default=120.0, help="Maximum seconds of audio to compare (default: 120s)")
    parser.add_argument("--sr", type=int, default=16000, help="Target sample rate (default: 16000 Hz)")
    parser.add_argument("--min-confidence", type=float, default=0.40, help="Minimum acceptable confidence threshold")
    parser.add_argument("--output-json", "--json", dest="output_json", action="store_true", default=False,
                        help="Output result as JSON string to stdout")

    args = parser.parse_args()

    yt_audio_path = args.opt_yt_audio or args.yt_audio
    ref_audio_path = args.opt_ref_audio or args.ref_audio
    vocals_audio_path = args.vocals_audio

    chart_p = Path(args.chart).resolve() if args.chart else None
    ref_p = Path(ref_audio_path).resolve() if ref_audio_path else None
    vocals_p = Path(vocals_audio_path).resolve() if vocals_audio_path else None
    yt_p = Path(yt_audio_path).resolve() if yt_audio_path else None

    # If measuring studio offset (Phase 2.2)
    if args.measure_studio_offset or (args.lyrics_json and not chart_p):
        target_vocals = vocals_p or yt_p
        if not target_vocals or not target_vocals.exists():
            err_msg = f"Vocals audio file not found: {target_vocals}"
            if args.output_json:
                print(json.dumps({"status": "error", "message": err_msg}))
            else:
                print(f"❌ {err_msg}", file=sys.stderr)
            sys.exit(1)
        lyrics_p = Path(args.lyrics_json).resolve() if args.lyrics_json else None
        if not lyrics_p or not lyrics_p.exists():
            err_msg = f"Lyrics file not found: {args.lyrics_json}"
            if args.output_json:
                print(json.dumps({"status": "error", "message": err_msg}))
            else:
                print(f"❌ {err_msg}", file=sys.stderr)
            sys.exit(1)

        try:
            res = measure_studio_offset(target_vocals, lyrics_p, sr=args.sr, max_duration=args.max_duration)
            if args.output_json:
                print(json.dumps(res))
            else:
                print(f"✅ Studio Offset: {res.get('studio_offset_sec', 0.0):+.3f}s (vocal: {res.get('vocal_first_sec')}s, lyric: {res.get('lyric_first_sec')}s)")
            sys.exit(0 if res.get("success") else 1)
        except Exception as e:
            if args.output_json:
                print(json.dumps({"status": "error", "message": str(e)}))
            else:
                print(f"❌ Error measuring studio offset: {e}", file=sys.stderr)
            sys.exit(1)

    # If aligning via vocals onset
    if vocals_p or args.method == "vocal_onset":
        target_vocals = vocals_p or yt_p
        if not target_vocals or not target_vocals.exists():
            err_msg = f"Vocals audio file not found: {target_vocals}"
            if args.output_json:
                print(json.dumps({"status": "error", "message": err_msg}))
            else:
                print(f"❌ {err_msg}", file=sys.stderr)
            sys.exit(1)
        if chart_p is None:
            err_msg = "Error: --chart must be provided when aligning via vocal onset"
            if args.output_json:
                print(json.dumps({"status": "error", "message": err_msg}))
            else:
                print(f"❌ {err_msg}", file=sys.stderr)
            sys.exit(1)

        try:
            result: SyncResult = align_audio_gap(
                vocals_audio=target_vocals,
                chart_path=chart_p,
                chart_gap_ms=args.chart_gap,
                update_chart=args.update_chart,
                out_chart_path=args.out_chart,
                sr=args.sr,
                max_duration=args.max_duration,
                method="vocal_onset",
            )
        except Exception as e:
            if args.output_json:
                print(json.dumps({"status": "error", "message": str(e)}))
            else:
                print(f"❌ Alignment failed: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        if not yt_audio_path:
            err_msg = "Error: Missing required YouTube audio path (yt_audio)"
            if args.output_json:
                print(json.dumps({"status": "error", "message": err_msg}))
            else:
                print(f"❌ {err_msg}", file=sys.stderr)
            sys.exit(1)

        if not yt_p.exists():
            err_msg = f"YouTube audio file not found: {yt_p}"
            if args.output_json:
                print(json.dumps({"status": "error", "message": err_msg}))
            else:
                print(f"❌ {err_msg}", file=sys.stderr)
            sys.exit(1)

        if ref_p is None and chart_p is None:
            err_msg = "Error: Must provide either ref_audio, --vocals-audio or --chart to align against"
            if args.output_json:
                print(json.dumps({"status": "error", "message": err_msg}))
            else:
                print(f"❌ {err_msg}", file=sys.stderr)
            sys.exit(1)

        try:
            result: SyncResult = align_audio_gap(
                yt_audio=yt_p,
                ref_audio=ref_p,
                vocals_audio=vocals_p,
                chart_path=chart_p,
                chart_gap_ms=args.chart_gap,
                update_chart=args.update_chart,
                out_chart_path=args.out_chart,
                sr=args.sr,
                max_duration=args.max_duration,
                method=args.method,
            )
        except Exception as e:
            if args.output_json:
                print(json.dumps({"status": "error", "message": str(e)}))
            else:
                print(f"❌ Alignment failed: {e}", file=sys.stderr)
            sys.exit(1)

    res_dict = result.to_dict()
    res_dict["status"] = "success"
    res_dict["chart_updated"] = bool(args.update_chart and chart_p)
    if args.update_chart and chart_p:
        res_dict["chart_path"] = str(Path(args.out_chart).resolve() if args.out_chart else chart_p)

    if args.output_json:
        print(json.dumps(res_dict, indent=2))
    else:
        print("=" * 60)
        print("🎯 FFT ACOUSTIC CROSS-CORRELATION ALIGNMENT RESULT")
        print("=" * 60)
        print(f"  • Detected Lag (tau*):    {result.lag_sec:+.4f} s ({result.lag_ms:+.1f} ms)")
        print(f"  • Alignment Confidence:  {result.confidence * 100:.1f}% (PSR: {result.details.get('psr', 0)})")
        print(f"  • Original #GAP:         {result.original_gap_ms:.1f} ms")
        print(f"  • Aligned Video #GAP:    {result.aligned_gap_ms:.1f} ms")
        print(f"  • Engine & Method:       {result.method.upper()}")
        if args.update_chart and chart_p:
            print(f"  ✅ Updated chart #GAP saved to: {chart_p}")
        print("=" * 60)

    if result.confidence < args.min_confidence:
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
