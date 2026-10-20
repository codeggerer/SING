#!/usr/bin/env python3
"""
Deep Multi-Island Genetic Optimizer for AI Karaoke Generator
Version 2.0 (Massive Scale Evolutionary Search / Island Model)

Features:
- Island Model Architecture: 8 independent parallel sub-populations preventing stagnation.
- Migration: Top individuals migrate between islands every N generations.
- Cataclysm / Anti-Stagnation: Extinction & hyper-mutation restarts stagnant islands.
- Fuzzy Syllable Sequence Alignment: Matches generated syllables to ground truth by text,
  preventing off-by-one index shifts from destroying fitness scores.
- Massive Parameter Exploration: 12 continuous and discrete acoustic genes.
- Live Dashboard with generation stats, island diversity, and auto-saving high scores.
- Graceful exit (Ctrl+C preserves best results and exports winning UltraStar chart).
"""

import os
import sys
import json
import time
import signal
import random
import argparse
import difflib
import numpy as np
from pathlib import Path

try:
    import librosa
except ImportError:
    librosa = None

import generate_karaoke as gk


# ==============================================================================
# 1. Extended Parameter Space (12 Genes)
# ==============================================================================

GENE_BOUNDS = {
    # Frequency bounds
    "vocal_fmin": (110.0, 150.0),
    "vocal_fmax": (800.0, 1150.0),

    # Confidence and energy
    "min_confidence": (0.18, 0.55),
    "consonant_zcr_max": (0.08, 0.45),
    "rms_percentile_cutoff": (3.0, 28.0),
    "rms_weight_power": (0.5, 2.5),

    # Vowel windowing
    "vowel_start_trim": (0.03, 0.25),
    "vowel_end_trim": (0.03, 0.25),

    # Syllable stability & spacing
    "intra_word_max_drop": (2.0, 7.0),
    "word_min_gap_ms": (35.0, 95.0),
    "min_note_dur_ms": (50.0, 130.0),

    # Discrete rules (mapped to integers)
    "unvoiced_fallback_mode": (0, 3),   # 0: prev note, 1: word root, 2: last syl, 3: scale snap
    "scale_snap_strength": (0, 2),      # 0: off, 1: strict snap, 2: soft snap (nearest in 1 st)
    "subharmonic_fold_thresh": (57.0, 62.0)
}


def create_random_individual():
    ind = {}
    for gene, (low, high) in GENE_BOUNDS.items():
        if isinstance(low, int) and isinstance(high, int):
            ind[gene] = random.randint(low, high)
        else:
            ind[gene] = round(random.uniform(low, high), 3)
    return ind


def mutate_individual(ind, mutation_rate=0.25, mutation_strength=0.15):
    new_ind = dict(ind)
    for gene, (low, high) in GENE_BOUNDS.items():
        if random.random() < mutation_rate:
            if isinstance(low, int) and isinstance(high, int):
                new_ind[gene] = random.randint(low, high)
            else:
                sigma = (high - low) * mutation_strength
                val = new_ind[gene] + random.gauss(0, sigma)
                new_ind[gene] = round(float(np.clip(val, low, high)), 3)
    return new_ind


def crossover_individuals(parent1, parent2):
    child1, child2 = {}, {}
    for gene, (low, high) in GENE_BOUNDS.items():
        v1 = parent1[gene]
        v2 = parent2[gene]
        if isinstance(low, int) and isinstance(high, int):
            child1[gene] = v1 if random.random() < 0.5 else v2
            child2[gene] = v2 if random.random() < 0.5 else v1
        else:
            alpha = random.uniform(-0.15, 1.15)
            c1 = alpha * v1 + (1.0 - alpha) * v2
            c2 = (1.0 - alpha) * v1 + alpha * v2
            child1[gene] = round(float(np.clip(c1, low, high)), 3)
            child2[gene] = round(float(np.clip(c2, low, high)), 3)
    return child1, child2


# ==============================================================================
# 2. Audio & Word Feature Precomputation
# ==============================================================================

def precompute_audio_features(vocals_path, cache_path):
    cache_file = Path(cache_path)
    required_keys = [
        "y", "sr", "rms", "zcr", "frame_dur",
        "f0_110", "prob_110", "f0_130", "prob_130", "f0_150", "prob_150"
    ]
    if cache_file.exists():
        data = np.load(str(cache_file))
        if all(k in data for k in required_keys):
            print(f"⚡ Lade vorberechnete Audio-Features: {cache_file}")
            return {
                "y": data["y"], "sr": int(data["sr"]), "rms": data["rms"], "zcr": data["zcr"],
                "frame_dur": float(data["frame_dur"]),
                "f0_110": data["f0_110"], "prob_110": data["prob_110"],
                "f0_130": data["f0_130"], "prob_130": data["prob_130"],
                "f0_150": data["f0_150"], "prob_150": data["prob_150"]
            }
        else:
            print(f"⚠️ Veralteter Feature-Cache ({cache_file}) mit fehlenden Rastern. Wird neu berechnet...")

    print("🧠 Berechne hochauflösendes Multi-Raster Audio-Feature-Set...")
    if librosa is None:
        raise RuntimeError("Librosa erforderlich.")

    y, sr = librosa.load(str(vocals_path), sr=22050, mono=True)
    hop_length = int(sr * 0.010)
    frame_dur = hop_length / sr

    rms = librosa.feature.rms(y=y, frame_length=hop_length * 2, hop_length=hop_length)[0]
    zcr = librosa.feature.zero_crossing_rate(y=y, frame_length=hop_length * 2, hop_length=hop_length)[0]

    print("   -> Berechne pYIN Raster 110 Hz...")
    f0_110, _, prob_110 = librosa.pyin(y, fmin=110, fmax=1150, sr=sr, hop_length=hop_length, fill_na=None)
    print("   -> Berechne pYIN Raster 130 Hz...")
    f0_130, _, prob_130 = librosa.pyin(y, fmin=130, fmax=1150, sr=sr, hop_length=hop_length, fill_na=None)
    print("   -> Berechne pYIN Raster 150 Hz...")
    f0_150, _, prob_150 = librosa.pyin(y, fmin=150, fmax=1150, sr=sr, hop_length=hop_length, fill_na=None)

    min_len = min(len(rms), len(zcr), len(f0_110), len(f0_130), len(f0_150))
    f0_110 = np.nan_to_num(f0_110[:min_len], nan=0.0)
    prob_110 = np.nan_to_num(prob_110[:min_len], nan=0.0)
    f0_130 = np.nan_to_num(f0_130[:min_len], nan=0.0)
    prob_130 = np.nan_to_num(prob_130[:min_len], nan=0.0)
    f0_150 = np.nan_to_num(f0_150[:min_len], nan=0.0)
    prob_150 = np.nan_to_num(prob_150[:min_len], nan=0.0)
    rms = rms[:min_len]
    zcr = zcr[:min_len]

    np.savez_compressed(
        str(cache_file),
        y=y, sr=sr, rms=rms, zcr=zcr, frame_dur=frame_dur,
        f0_110=f0_110, prob_110=prob_110, f0_130=f0_130, prob_130=prob_130,
        f0_150=f0_150, prob_150=prob_150
    )
    print(f"✅ Multi-Raster Features gespeichert: {cache_file}")

    return {
        "y": y, "sr": sr, "rms": rms, "zcr": zcr, "frame_dur": frame_dur,
        "f0_110": f0_110, "prob_110": prob_110, "f0_130": f0_130, "prob_130": prob_130,
        "f0_150": f0_150, "prob_150": prob_150
    }


def load_words(words_cache_path):
    with open(words_cache_path, "r", encoding="utf-8") as f:
        return json.load(f)


# ==============================================================================
# 3. High-Speed Pipeline Evaluation (Vectorized Interpolation)
# ==============================================================================

def evaluate_candidate(params, audio_feat, words, scale_pcs):
    frame_dur = audio_feat["frame_dur"]
    fmin = params["vocal_fmin"]

    # Quadratic / Tri-linear interpolation between 110, 130, 150 Hz models
    if fmin <= 130.0:
        r = float(np.clip((fmin - 110.0) / 20.0, 0.0, 1.0))
        f0 = (1.0 - r) * audio_feat["f0_110"] + r * audio_feat["f0_130"]
        conf = (1.0 - r) * audio_feat["prob_110"] + r * audio_feat["prob_130"]
    else:
        r = float(np.clip((fmin - 130.0) / 20.0, 0.0, 1.0))
        f0 = (1.0 - r) * audio_feat["f0_130"] + r * audio_feat["f0_150"]
        conf = (1.0 - r) * audio_feat["prob_130"] + r * audio_feat["prob_150"]

    rms = audio_feat["rms"]
    zcr = audio_feat["zcr"]

    with np.errstate(divide='ignore', invalid='ignore'):
        midi_arr = np.where(f0 > 0, 69.0 + 12.0 * np.log2(f0 / 440.0), 60.0)

    total_frames = len(midi_arr)
    s_trim = params["vowel_start_trim"]
    e_trim = params["vowel_end_trim"]
    min_conf = params["min_confidence"]
    zcr_max = params["consonant_zcr_max"]
    rms_power = params["rms_weight_power"]
    rms_cutoff = np.percentile(rms, params["rms_percentile_cutoff"])
    max_drop = params["intra_word_max_drop"]
    fallback_mode = int(params["unvoiced_fallback_mode"])
    scale_mode = int(params["scale_snap_strength"])
    subharmonic_thresh = params["subharmonic_fold_thresh"]
    min_gap_sec = params["word_min_gap_ms"] / 1000.0
    min_dur_sec = params["min_note_dur_ms"] / 1000.0

    generated_notes = []
    # Dynamic anchor from first valid singing frames
    valid_init = midi_arr[conf > 0.4]
    prev_pitch = int(round(np.median(valid_init))) if len(valid_init) > 0 else 67
    last_word_end = 0.0

    for w in words:
        w_start = w["start"]
        if last_word_end > 0.0 and w_start < last_word_end + min_gap_sec:
            w_start = last_word_end + min_gap_sec

        w_end = max(w["end"], w_start + min_dur_sec)
        w_dur = w_end - w_start

        syllables = gk.split_syllables(w["word"], lang="de", word_duration=w_dur)
        num_sylls = len(syllables)
        dur_per_syl = w_dur / num_sylls

        word_notes = []
        for s_idx, syl in enumerate(syllables):
            s_start = w_start + (s_idx * dur_per_syl)
            s_end = s_start + dur_per_syl
            s_dur = s_end - s_start

            c_start = s_start + (s_dur * s_trim)
            c_end = s_end - (s_dur * e_trim)
            sf = max(0, int(c_start / frame_dur))
            ef = min(total_frames, int(c_end / frame_dur))

            pitch = prev_pitch
            if ef > sf:
                m_slice = midi_arr[sf:ef]
                c_slice = conf[sf:ef]
                r_slice = rms[sf:ef]
                z_slice = zcr[sf:ef]

                valid = (c_slice >= min_conf) & (r_slice >= rms_cutoff) & (z_slice <= zcr_max)
                if np.any(valid):
                    weights = c_slice[valid] * (r_slice[valid] ** rms_power)
                    v_midis = m_slice[valid]
                    sort_i = np.argsort(v_midis)
                    cum_w = np.cumsum(weights[sort_i])
                    med_i = np.searchsorted(cum_w, cum_w[-1] / 2.0)
                    pitch = int(round(v_midis[sort_i][min(med_i, len(v_midis) - 1)]))
                else:
                    if fallback_mode == 0:
                        pitch = prev_pitch
                    elif fallback_mode == 1 and word_notes:
                        pitch = word_notes[0]["pitch"]
                    elif fallback_mode == 2:
                        pitch = word_notes[-1]["pitch"] if word_notes else prev_pitch
                    else:
                        pitch = gk.snap_pitch_to_scale(prev_pitch, scale_pcs)

            # Subharmonic fold
            if pitch <= subharmonic_thresh:
                pitch += 12

            # Scale snapping
            if scale_mode == 1 and scale_pcs:
                pitch = gk.snap_pitch_to_scale(pitch, scale_pcs)
            elif scale_mode == 2 and scale_pcs:
                # Soft snap only if within 1 semitone of scale
                snapped = gk.snap_pitch_to_scale(pitch, scale_pcs)
                if abs(snapped - pitch) <= 1:
                    pitch = snapped

            prev_pitch = pitch
            is_last = (s_idx == num_sylls - 1)
            word_notes.append({
                "syllable": syl,
                "start": s_start,
                "end": s_end,
                "pitch": pitch,
                "is_last": is_last
            })

        # Intra-word plunge anchor
        if len(word_notes) > 1:
            root_p = word_notes[0]["pitch"]
            for wn in word_notes[1:]:
                if (root_p - wn["pitch"]) >= max_drop:
                    wn["pitch"] = root_p

        if word_notes:
            last_word_end = word_notes[-1]["end"]

        generated_notes.extend(word_notes)

    return generated_notes


# ==============================================================================
# 4. Fuzzy Sequence Alignment Fitness Function
# ==============================================================================

def align_and_score_fitness(generated_notes, ground_truth_notes, params):
    """
    Uses Sequence Alignment (difflib opcode matching on syllable tokens)
    so that a single missed or extra syllable does NOT destroy all following notes!
    """
    gt_sylls = [n["syllable"].lower().rstrip(',.!-?~ ') for n in ground_truth_notes]
    gen_sylls = [n["syllable"].lower().rstrip(',.!-?~ ') for n in generated_notes]

    matcher = difflib.SequenceMatcher(None, gt_sylls, gen_sylls, autojunk=False)
    matching_blocks = matcher.get_matching_blocks()

    score = 0.0
    exact_matches = 0
    close_matches = 0
    keller_drops = 0
    octave_errors = 0
    total_evaluated = 0

    for gt_i, gen_i, length in matching_blocks:
        for k in range(length):
            gt = ground_truth_notes[gt_i + k]
            gen = generated_notes[gen_i + k]
            total_evaluated += 1

            p_gt = gt["pitch"]
            p_gen = gen["pitch"]
            diff = abs(p_gen - p_gt)

            if diff == 0:
                score += 100.0
                exact_matches += 1
            elif diff == 1:
                score += 45.0
                close_matches += 1
            elif diff == 2:
                score += 20.0
            elif diff >= 12:
                score -= 120.0
                octave_errors += 1
            else:
                score -= (diff * 12.0)

            # Keller drop penalty
            if p_gen == 60 and p_gt >= 67:
                score -= 150.0
                keller_drops += 1

    # Length & alignment penalty
    unmatched_gt = len(ground_truth_notes) - total_evaluated
    score -= (unmatched_gt * 60.0)

    # Word collision penalty
    min_gap_sec = params["word_min_gap_ms"] / 1000.0
    collisions = 0
    for i in range(1, len(generated_notes)):
        if generated_notes[i-1]["is_last"]:
            gap = generated_notes[i]["start"] - generated_notes[i-1]["end"]
            if gap < min_gap_sec * 0.4:
                score -= 75.0
                collisions += 1

    accuracy_pct = (exact_matches / total_evaluated * 100.0) if total_evaluated > 0 else 0.0

    return {
        "fitness": score,
        "accuracy_pct": accuracy_pct,
        "exact_matches": exact_matches,
        "total_evaluated": total_evaluated,
        "keller_drops": keller_drops,
        "octave_errors": octave_errors,
        "collisions": collisions
    }


# ==============================================================================
# 5. Multi-Island Genetic Engine (Inselmodell)
# ==============================================================================

class Island:
    def __init__(self, island_id, pop_size, mutation_rate, mutation_strength, strategy_name):
        self.island_id = island_id
        self.pop_size = pop_size
        self.mutation_rate = mutation_rate
        self.mutation_strength = mutation_strength
        self.strategy_name = strategy_name
        self.population = [create_random_individual() for _ in range(pop_size)]
        self.stagnant_generations = 0
        self.best_fitness = -float("inf")
        self.best_individual = None
        self.best_stats = None

    def evaluate(self, audio_feat, words, gt_notes, scale_pcs):
        evaluated = []
        for ind in self.population:
            gen_notes = evaluate_candidate(ind, audio_feat, words, scale_pcs)
            res = align_and_score_fitness(gen_notes, gt_notes, ind)
            evaluated.append((res["fitness"], ind, res))

        evaluated.sort(key=lambda x: x[0], reverse=True)
        cur_best_fit, cur_best_ind, cur_best_stats = evaluated[0]

        if cur_best_fit > self.best_fitness + 5.0:
            self.best_fitness = cur_best_fit
            self.best_individual = dict(cur_best_ind)
            self.best_stats = dict(cur_best_stats)
            self.stagnant_generations = 0
        else:
            self.stagnant_generations += 1

        return evaluated

    def evolve(self, evaluated_pop):
        # Anti-Stagnation Cataclysm: If island stagnates for 18 generations, trigger hyper-mutation!
        if self.stagnant_generations >= 18:
            new_pop = [dict(self.best_individual)]
            for _ in range(self.pop_size - 1):
                new_pop.append(mutate_individual(self.best_individual, mutation_rate=0.6, mutation_strength=0.35))
            self.population = new_pop
            self.stagnant_generations = 0
            return

        new_pop = []
        # Elitism: top 2 survive
        new_pop.append(dict(evaluated_pop[0][1]))
        new_pop.append(dict(evaluated_pop[1][1]))

        # Breed the rest
        while len(new_pop) < self.pop_size:
            t1 = random.sample(evaluated_pop[:self.pop_size // 2], 2)
            t2 = random.sample(evaluated_pop[:self.pop_size // 2], 2)
            p1 = max(t1, key=lambda x: x[0])[1]
            p2 = max(t2, key=lambda x: x[0])[1]

            c1, c2 = crossover_individuals(p1, p2)
            new_pop.append(mutate_individual(c1, self.mutation_rate, self.mutation_strength))
            if len(new_pop) < self.pop_size:
                new_pop.append(mutate_individual(c2, self.mutation_rate, self.mutation_strength))

        self.population = new_pop


# Signal handling
stop_requested = False
def sigint_handler(signum, frame):
    global stop_requested
    print("\n⚠️ Abbruch-Signal (Ctrl+C) empfangen! Schließe Generation ab und sichere beste Ergebnisse...")
    stop_requested = True

signal.signal(signal.SIGINT, sigint_handler)


def run_massive_optimization(vocals_path, ground_truth_path, output_dir, generations=500, num_islands=8, pop_per_island=30):
    global stop_requested

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    with open(ground_truth_path, "r", encoding="utf-8") as f:
        gt_data = json.load(f)
    gt_notes = gt_data["notes"]
    title = gt_data.get("title", "Optimized Song")
    artist = gt_data.get("artist", "Various Artists")
    bpm = gt_data.get("bpm", 120)
    key_name = gt_data.get("key", "C Major")

    vocals_stem = Path(vocals_path).stem
    cache_npz = output_dir / f"{vocals_stem}_precomputed_features.npz"
    audio_feat = precompute_audio_features(vocals_path, cache_npz)

    words_cache = output_dir / f"{vocals_stem}_whisper_words.json"
    words = load_words(words_cache)

    key_info = gk.detect_song_key("", manual_key=key_name) if hasattr(gk, 'detect_song_key') else None
    scale_pcs = key_info["scale_pcs"] if key_info else {0, 2, 4, 5, 7, 9, 11}

    # Create Diverse Islands
    strategies = [
        ("Exploiter (Fein-Tuning)", 0.15, 0.08),
        ("Balanced (Standard)", 0.25, 0.15),
        ("Aggressive Explorer", 0.40, 0.25),
        ("Wild Mutator", 0.55, 0.35),
        ("Pitch-Focus", 0.20, 0.12),
        ("Rhythm-Focus", 0.25, 0.18),
        ("Anti-Drop Focus", 0.30, 0.20),
        ("Deep Inversion", 0.35, 0.22)
    ]
    islands = []
    for i in range(num_islands):
        strat = strategies[i % len(strategies)]
        islands.append(Island(i + 1, pop_per_island, strat[1], strat[2], strat[0]))

    total_pop = num_islands * pop_per_island
    print(f"\n🏝️ Starte Multi-Insel-Evolution: {num_islands} Inseln, {total_pop} Individuen/Gen, {generations} Generationen")
    print("=" * 80)

    best_global_fitness = -float("inf")
    best_global_ind = None
    best_global_stats = None

    start_t = time.time()

    for gen in range(1, generations + 1):
        if stop_requested:
            break

        gen_best_fitness = -float("inf")
        gen_best_ind = None
        gen_best_stats = None

        # 1. Evaluate all islands
        for island in islands:
            eval_pop = island.evaluate(audio_feat, words, gt_notes, scale_pcs)
            island_top_fit, island_top_ind, island_top_stats = eval_pop[0]

            if island_top_fit > gen_best_fitness:
                gen_best_fitness = island_top_fit
                gen_best_ind = island_top_ind
                gen_best_stats = island_top_stats

            island.evolve(eval_pop)

        # 2. Check for Global Highscore
        if gen_best_fitness > best_global_fitness:
            best_global_fitness = gen_best_fitness
            best_global_ind = dict(gen_best_ind)
            best_global_stats = dict(gen_best_stats)

            # Auto-save
            best_json = output_dir / "best_karaoke_params.json"
            with open(best_json, "w", encoding="utf-8") as f:
                json.dump({
                    "fitness": best_global_fitness,
                    "accuracy_pct": best_global_stats["accuracy_pct"],
                    "matched_notes": best_global_stats["exact_matches"],
                    "total_evaluated": best_global_stats["total_evaluated"],
                    "parameters": best_global_ind,
                    "timestamp": time.strftime("%Y-%m-%d %H:%M:%S")
                }, f, indent=2)

        # 3. Inter-Island Migration (Every 12 generations)
        if gen % 12 == 0:
            for i in range(num_islands):
                next_i = (i + 1) % num_islands
                # Migrate top individual to neighbor island
                islands[next_i].population[-1] = dict(islands[i].best_individual)

        elapsed = time.time() - start_t
        active_cataclysms = sum(1 for isl in islands if isl.stagnant_generations == 0)

        # Live Display
        print(f"Gen {gen:04d}/{generations} | Best: {gen_best_fitness:7.0f} pts | "
              f"Treffer: {gen_best_stats['accuracy_pct']:5.1f}% ({gen_best_stats['exact_matches']}/{gen_best_stats['total_evaluated']}) | "
              f"Drops: {gen_best_stats['keller_drops']} | Overtone: {gen_best_stats['octave_errors']} | "
              f"All-Time: {best_global_fitness:7.0f} ({best_global_stats['accuracy_pct']:5.1f}%) [{elapsed:4.0f}s]")

    print("=" * 80)
    print("🏆 MASSIVE EVOLUTION ERFOLGREICH BEENDET!")
    print(f"Beste Fitness: {best_global_fitness:.0f} Punkte")
    print(f"Trefferquote auf Notenblatt: {best_global_stats['accuracy_pct']:.1f}% ({best_global_stats['exact_matches']} von {best_global_stats['total_evaluated']} Noten exakt getroffen)")
    print(f"Kollisionen: {best_global_stats['collisions']}, Keller-Drops: {best_global_stats['keller_drops']}")

    # Export final UltraStar chart with winning parameters
    safe_name = f"{artist} - {title} [Evolution Optimized]".replace('/', '_').replace('\\', '_')
    opt_txt = output_dir / f"{safe_name}.txt"
    winning_notes = evaluate_candidate(best_global_ind, audio_feat, words, scale_pcs)
    _export_to_ultrastar(winning_notes, str(opt_txt), title=title, artist=artist, bpm=bpm, key_name=key_name)
    print(f"\n🎉 Gewinner-Chart gespeichert: {opt_txt}")
    print(f"📁 Optimale Parameter gespeichert: {output_dir / 'best_karaoke_params.json'}")


def _export_to_ultrastar(notes, output_path, title="Optimized Song", artist="Various Artists", bpm=120, key_name="C Major"):
    lines = [
        f"#TITLE:{title}",
        f"#ARTIST:{artist}",
        "#BPM:1500.0",
        f"#REALBPM:{bpm}",
        "#GAP:0",
        f"#KEY:{key_name}",
        "#GENRE:Karaoke AI (Deep Island Optimized)"
    ]
    last_end = 0
    for n in notes:
        s_beat = int(round(n["start"] / 0.01))
        e_beat = int(round(n["end"] / 0.01))
        if s_beat < last_end + 3:
            s_beat = last_end + 3
        d_beat = max(8, e_beat - s_beat)
        last_end = s_beat + d_beat
        txt_part = f"{n['syllable']} " if n["is_last"] else f"{n['syllable']}-"
        lines.append(f": {s_beat} {d_beat} {n['pitch']} {txt_part}")
    lines.append("E")
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Deep Multi-Island Genetic Optimizer for AI Karaoke")
    parser.add_argument("--vocals", default="vocals.wav", help="Path to vocal stem WAV/MP3 file")
    parser.add_argument("--ground-truth", default="ground_truth_sample.json", help="Path to ground truth JSON file")
    parser.add_argument("--output-dir", default="./output")
    parser.add_argument("--generations", type=int, default=1000, help="Anzahl der Generationen (z.B. 1000 oder 3000)")
    parser.add_argument("--islands", type=int, default=8, help="Anzahl unabhängiger Inseln")
    parser.add_argument("--pop-per-island", type=int, default=30, help="Individuen pro Insel")

    args = parser.parse_args()
    run_massive_optimization(args.vocals, args.ground_truth, args.output_dir, args.generations, args.islands, args.pop_per_island)
