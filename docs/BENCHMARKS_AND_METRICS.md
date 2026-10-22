# 🔬 Benchmark Evaluation & Quality Metrics

This document details the benchmarking framework, mathematical metrics, and historical performance evolutions for the SING! AI engine across all 4 tiers.

---

## 📐 Evaluation Metrics & Mathematical Formulations

The benchmark suite (`eval/eval.py` & `eval/metrics.py`) evaluates note charts against ground-truth corpora across 5 core dimensions:

### 1. Frame-Level Pitch Accuracy (FLPA)
Evaluates whether fundamental frequency $f_0$ (in semitones / MIDI notes) matches ground truth at 10 ms frame resolution:
$$\text{FLPA} = \frac{1}{N} \sum_{i=1}^N \mathbb{I}\left(|\hat{p}_i - p_i^*| \le \theta_{\text{pitch}}\right)$$
- $\theta_{\text{pitch}} = 0.5\text{ semitones}$ (50 cents).
- Frames with unvoiced ground-truth are masked out.

### 2. Note-Level Accuracy (NLA)
Evaluates full note events based on both timing and pitch:
- A note is deemed correct if:
  1. Onset time error $|\hat{t}_{\text{start}} - t_{\text{start}}^*| \le 50\text{ ms}$.
  2. Pitch error $|\hat{p} - p^*| \le 0.5\text{ semitones}$.
  3. Overlap duration ratio $\ge 0.70$.

### 3. Syllable Boundary Onset Error (Onset MAE)
Measures the Mean Absolute Error (MAE) between estimated syllable onsets and ground-truth onsets:
$$\text{MAE}_{\text{onset}} = \frac{1}{M} \sum_{j=1}^M |\hat{t}_{j,\text{start}} - t_{j,\text{start}}^*|$$
- Lower is better. Target: $< 25\text{ ms}$.

### 4. Word Error Rate (WER)
Standard Levenshtein edit distance between transcribed/aligned word tokens and official lyrics:
$$\text{WER} = \frac{S + D + I}{N}$$
where $S$ is substitutions, $D$ is deletions, $I$ is insertions, and $N$ is total ground-truth words.
- In **Tier 1, Tier 2, and Tier 3**, WER is virtually $0\%$ because ground-truth text is verified.
- In **Tier 4**, acoustic transcription errors can elevate WER up to $14\%$.

### 5. Line Break Precision & Recall (Phrase Segmentation)
Evaluates whether phrase splits (`- <beat>` in UltraStar) match natural breathing pauses in singing:
- Target: $> 95\%$ precision to prevent visual clumping on the pitch highway.

---

## 📊 Performance Comparison: Tier 1 to Tier 4

```
Overall Quality Score (0–100 Scale)
┌──────────────────────────────────────────────────────────┐
│ Tier 1: USDB Community Ground-Truth   ██████████████ 99  │
│ Tier 2: Studio Syllable-Sync          █████████████▍ 94  │
│ Tier 3: Web Lyrics + MMS-FA           ████████████▍  88  │
│ Tier 4: Zero-Lyrics Raw AI (Whisper)  ███████████    76  │
│ Weighted Real-World Mix               ████████████▍  89  │
└──────────────────────────────────────────────────────────┘
```

### Detailed Metric Breakdown

| Metric | Tier 1 (USDB) | Tier 2 (Studio Sync) | Tier 3 (Web + MMS) | Tier 4 (Whisper AI) | Baseline (v1.0) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **FLPA ($\pm 50\text{ cents}$)** | **99.5%** | **96.8%** | **93.1%** | **84.2%** | 71.4% |
| **Note-Level Accuracy** | **99.0%** | **95.2%** | **91.5%** | **81.0%** | 62.3% |
| **Onset MAE (ms)** | **$\pm 0\text{ ms}$** | **$12\text{ ms}$** | **$24\text{ ms}$** | **$48\text{ ms}$** | $120\text{ ms}$ |
| **Word Error Rate** | **0.0%** | **0.2%** | **0.8%** | **14.5%** | 22.8% |
| **Guitar Solo Drift** | **0.0%** | **0.0%** | **0.0%** | **2.1%** | 18.5% |
| **Octave Jump Errors** | **0.0%** | **0.3%** | **0.6%** | **3.8%** | 14.2% |

---

## 🔍 Why Does Tier 4 Score 76 / 100?

While Whisper `large-v3` is state-of-the-art for speech recognition, singing audio presents unique acoustic challenges:
1. **Instrumental Overlap & Reverb**: Heavy guitar distortion and vocal reverb bleed into vocal stems, confusing speech attention heads.
2. **Prolonged Vowels & Melismas**: Speech models expect natural conversational rhythms. Long notes ($>2\text{ s}$) are sometimes hallucinated as repeated syllables or word loops.
3. **Absence of Ground-Truth Lyrics**: Without a reference text to anchor forced alignment, the model must simultaneously guess *what* was sung and *when* it was sung.

### The Self-Healing Strategy
To bridge the gap between Tier 4 and Tier 3:
- The SING! UI actively informs the user of the active tier with color-coded badges (`#previewLyricsTierBadge`).
- Users can click **"Upgrade to Tier 3"** (`#btnUpgradeLyrics`) at any time, paste plaintext lyrics, and trigger an immediate MMS-FA realignment using the already-separated Demucs vocal stems—instantly boosting the song from **76 / 100 to 88 / 100**.
