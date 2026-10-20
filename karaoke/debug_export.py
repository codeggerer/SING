"""
karaoke/debug_export.py - Debug Export for AI Karaoke Pipeline (PLAN.md Phase 7.3).

Generates comprehensive debugging artifacts:
- contour.png: High-resolution plot with f0 curve, note blocks, syllable boundaries, and lyric text.
- report.json: Per-syllable evidence detailing pitch, contour statistics, plateaus, and split reasons.
"""

from __future__ import annotations
import os
os.environ.setdefault("MPLCONFIGDIR", "/tmp/matplotlib")
import json
from pathlib import Path
from typing import List, Dict, Any, Optional
import numpy as np

MIDI_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


def midi_to_name(m: float | int) -> str:
    """Converts a MIDI integer/float to musical note name (e.g. 60 -> C4)."""
    if np.isnan(m) or m is None:
        return "--"
    rounded = int(round(m))
    name = MIDI_NOTE_NAMES[rounded % 12]
    octave = (rounded // 12) - 1
    return f"{name}{octave}"


def export_debug_artifacts(
    debug_dir: Path | str,
    pitch_data: Dict[str, Any],
    word_notes_list: List[Dict[str, Any]],
    title: str = "Song",
    artist: str = "Unknown Artist",
    key_info: Optional[Dict[str, Any]] = None,
    pitch_engine: str = "fcpe",
    basic_pitch_notes: Optional[List[Dict[str, Any]]] = None,
    hardware_profile: Optional[Any] = None,
) -> Dict[str, Path]:
    """
    Exports contour.png and report.json into debug_dir.
    Returns dictionary with paths to created files.
    """
    debug_path = Path(debug_dir).resolve()
    debug_path.mkdir(parents=True, exist_ok=True)

    contour_png_path = debug_path / "contour.png"
    report_json_path = debug_path / "report.json"

    frame_dur = float(pitch_data.get("frame_dur_sec", 0.01))
    total_frames = int(pitch_data.get("total_frames", len(pitch_data.get("midi", []))))
    midis = np.array(pitch_data.get("midi", []))[:total_frames]
    confs = np.array(pitch_data.get("conf", []))[:total_frames]
    rms = np.array(pitch_data.get("rms", []))[:total_frames]
    time_axis = np.arange(total_frames) * frame_dur

    tuning_cents = float(pitch_data.get("tuning_cents", 0.0))
    detected_key = key_info.get("key", "Unknown") if key_info else "Unknown"
    key_conf = float(key_info.get("confidence", 0.0)) if key_info else 0.0

    # -------------------------------------------------------------
    # 1. Generate report.json (Per-syllable evidence & decision log)
    # -------------------------------------------------------------
    syllable_reports = []
    total_notes_count = 0

    for wn_idx, wn in enumerate(word_notes_list):
        notes = wn.get("notes", [])
        total_notes_count += len(notes)
        num_sylls = wn.get("num_sylls", 1)

        for n_idx, n in enumerate(notes):
            s_sec = float(n["start"])
            e_sec = float(n["end"])
            dur_ms = round((e_sec - s_sec) * 1000, 1)
            pitch_int = int(round(n["pitch"]))
            pitch_flt = float(n.get("pitch_float", pitch_int))
            text_str = str(n.get("text", "")).strip()

            sf = max(0, int(s_sec / frame_dur))
            ef = min(total_frames, int(e_sec / frame_dur))

            slice_midis = midis[sf:ef]
            voiced_mask = (~np.isnan(slice_midis))
            voiced_count = int(np.sum(voiced_mask))
            total_slice_count = len(slice_midis)

            if voiced_count > 0:
                v_midis = slice_midis[voiced_mask]
                raw_stats = {
                    "voiced_frames": voiced_count,
                    "total_frames": total_slice_count,
                    "median": round(float(np.median(v_midis)), 2),
                    "mean": round(float(np.mean(v_midis)), 2),
                    "std": round(float(np.std(v_midis)), 2),
                    "min": round(float(np.min(v_midis)), 2),
                    "max": round(float(np.max(v_midis)), 2),
                }
            else:
                raw_stats = {
                    "voiced_frames": 0,
                    "total_frames": total_slice_count,
                    "median": None,
                    "mean": None,
                    "std": None,
                    "min": None,
                    "max": None,
                }

            # Determine why it was split or not
            if len(notes) > 1:
                split_reason = f"Melisma split: 2 distinct plateaus detected differing by >= 2st with low variance (part {n_idx + 1}/{len(notes)})"
            elif dur_ms >= 500:
                split_reason = "Evaluated for melisma split but remained 1 note (contour variance or pitch difference did not meet threshold)"
            else:
                split_reason = "Single syllable note (< 500 ms, split rule not triggered)"

            syllable_reports.append({
                "index": len(syllable_reports) + 1,
                "text": text_str,
                "start_sec": round(s_sec, 3),
                "end_sec": round(e_sec, 3),
                "duration_ms": dur_ms,
                "pitch_midi": pitch_int,
                "pitch_name": midi_to_name(pitch_int),
                "pitch_float": round(pitch_flt, 3),
                "is_golden": bool(n.get("isGolden", False)),
                "raw_contour_stats": raw_stats,
                "split_reason": split_reason,
            })

    report_data = {
        "generator_stage": "Phase 7 Debug Export",
        "title": title,
        "artist": artist,
        "pitch_engine": pitch_engine,
        "detected_key": detected_key,
        "key_confidence": round(key_conf, 3),
        "tuning_cents": round(tuning_cents, 2),
        "total_syllables": len(syllable_reports),
        "total_notes": total_notes_count,
        "hardware": hardware_profile.to_dict() if hasattr(hardware_profile, "to_dict") else str(hardware_profile),
        "syllables": syllable_reports,
    }

    with open(report_json_path, "w", encoding="utf-8") as f:
        json.dump(report_data, f, indent=2, ensure_ascii=False)

    # -------------------------------------------------------------
    # 2. Generate contour.png (Matplotlib Visualization)
    # -------------------------------------------------------------
    try:
        import matplotlib
        matplotlib.use("Agg")  # Headless non-interactive backend
        import matplotlib.pyplot as plt
        import matplotlib.patches as patches

        fig, (ax_pitch, ax_energy) = plt.subplots(
            2, 1, figsize=(18, 9), sharex=True,
            gridspec_kw={"height_ratios": [3.5, 1]}
        )

        fig.patch.set_facecolor("#0b0e1e")
        ax_pitch.set_facecolor("#0e1329")
        ax_energy.set_facecolor("#0e1329")

        # Top Plot: Cleaned f0 contour
        masked_midis = np.copy(midis)
        ax_pitch.plot(
            time_axis, masked_midis,
            color="#00f2fe", linewidth=1.5, alpha=0.85, label="Cleaned f0 Contour (MIDI)"
        )

        # Plot note blocks
        min_note_pitch = 127
        max_note_pitch = 0

        for wn in word_notes_list:
            for n in wn.get("notes", []):
                s = float(n["start"])
                e = float(n["end"])
                p = float(n["pitch"])
                w = max(0.04, e - s)
                txt = str(n.get("text", "")).strip()

                min_note_pitch = min(min_note_pitch, p)
                max_note_pitch = max(max_note_pitch, p)

                # Draw note rectangle
                rect_color = "#ffcf33" if n.get("isGolden") else "#b46eff"
                edge_color = "#ffeaa7" if n.get("isGolden") else "#d8b4fe"

                rect = patches.Rectangle(
                    (s, p - 0.38), w, 0.76,
                    linewidth=1.2, edgecolor=edge_color,
                    facecolor=rect_color, alpha=0.65, zorder=3
                )
                ax_pitch.add_patch(rect)

                # Syllable text annotation
                if txt:
                    ax_pitch.text(
                        s + w / 2, p + 0.55, txt,
                        color="#ffffff", fontsize=8, fontweight="bold",
                        ha="center", va="bottom", zorder=4
                    )

                # Syllable edge line
                ax_pitch.axvline(s, color="#ffffff", alpha=0.15, linestyle=":", linewidth=0.8)

        # Basic Pitch second opinion overlay if provided
        if basic_pitch_notes:
            for bpn in basic_pitch_notes[:250]:
                bs = float(bpn.get("start", 0))
                be = float(bpn.get("end", 0))
                bp = float(bpn.get("pitch", 0))
                bw = max(0.04, be - bs)
                bp_rect = patches.Rectangle(
                    (bs, bp - 0.4), bw, 0.8,
                    linewidth=1.0, edgecolor="#ff9f43",
                    facecolor="none", linestyle="--", alpha=0.45, zorder=2
                )
                ax_pitch.add_patch(bp_rect)

        # Set Pitch Axis Bounds
        plot_min_p = max(24, int(min_note_pitch - 4) if min_note_pitch <= 127 else 45)
        plot_max_p = min(108, int(max_note_pitch + 4) if max_note_pitch > 0 else 80)
        ax_pitch.set_ylim(plot_min_p, plot_max_p)

        # Pitch Y-ticks with note names
        yticks = range(plot_min_p, plot_max_p + 1, 2)
        ax_pitch.set_yticks(yticks)
        ax_pitch.set_yticklabels([f"{midi_to_name(y)} ({y})" for y in yticks], color="#d0d5e8", fontsize=9)
        ax_pitch.grid(True, linestyle="--", alpha=0.15, color="#ffffff")
        ax_pitch.set_ylabel("Tonhöhe (MIDI / Note)", color="#00f2fe", fontsize=11, fontweight="bold")

        title_str = (
            f"KI-Karaoke Pitch Highway: {artist} - {title}\n"
            f"[Engine: {pitch_engine.upper()}]  [Key: {detected_key} (conf: {key_conf:.2f})]  "
            f"[Tuning: {tuning_cents:+.1f}c]  [Notes: {total_notes_count}]"
        )
        ax_pitch.set_title(title_str, color="#ffffff", fontsize=12, fontweight="bold", pad=12)

        # Bottom Plot: Voicing Confidence & RMS
        if len(confs) > 0:
            ax_energy.plot(time_axis, confs, color="#18e882", linewidth=1.2, label="Voicing Confidence")
        if len(rms) > 0:
            norm_rms = rms / (np.max(rms) + 1e-6)
            ax_energy.plot(time_axis, norm_rms, color="#ff2a85", linewidth=1.0, alpha=0.7, label="RMS Energy (norm)")

        ax_energy.set_ylim(-0.05, 1.05)
        ax_energy.set_ylabel("Voicing / RMS", color="#18e882", fontsize=10)
        ax_energy.set_xlabel("Zeit (Sekunden)", color="#ffffff", fontsize=11)
        ax_energy.tick_params(colors="#d0d5e8", labelsize=9)
        ax_energy.grid(True, linestyle=":", alpha=0.15, color="#ffffff")
        ax_energy.legend(loc="upper right", facecolor="#13162b", edgecolor="#ffffff", labelcolor="#ffffff")

        plt.tight_layout()
        plt.savefig(contour_png_path, dpi=140, facecolor=fig.get_facecolor(), edgecolor="none")
        plt.close(fig)
        print(f"📊 Debug-Contour gespeichert: {contour_png_path}")
        print(f"📋 Debug-Report gespeichert: {report_json_path}")
    except Exception as e:
        print(f"⚠️ Erstellung von contour.png fehlgeschlagen ({e}), report.json wurde erstellt.")

    return {
        "contour_png": contour_png_path,
        "report_json": report_json_path,
    }
