# 📚 SING! Documentation Hub

Welcome to the technical documentation repository for the **SING! Web Studio & AI Karaoke Engine**.

---

## 🗺️ Documentation Directory

### Architecture & Engine Design
- **[4-Tier Consistency Architecture](./FOUR_TIER_ARCHITECTURE.md)**: Comprehensive breakdown of Tier 1 (USDB Ground-Truth), Tier 2 (Studio Syllable-Sync), Tier 3 (Web Lyrics + MMS-FA), and Tier 4 (Whisper-AI Fallback). Includes quality scores, tolerances, and fallback mechanics.
- **[Plain-Text Lyrics Harvester & Meta MMS-FA](./LYRICS_HARVESTER_AND_FORCED_ALIGNMENT.md)**: Deep dive into the 5-source web harvester (YouTube description cleaner, Genius container scraper, LRCLIB, DuckDuckGo snippets) and Meta MMS-FA VAD-island forced alignment.
- **[Architecture Decision Records (ADRs)](./decisions.md)**: Engineering decisions regarding Spotify Color-Lyrics internal tokens and SpicyLyrics payload schemas.

### Benchmarks & Evaluation
- **[Benchmark Evaluation & Quality Metrics](./BENCHMARKS_AND_METRICS.md)**: Mathematical definitions of Frame-Level Pitch Accuracy (FLPA), Note-Level Accuracy (NLA), Syllable Onset MAE, and historical accuracy scores.

### Developer Guides
- **[Developer & Agent Guide (`AGENTS.md`)](../AGENTS.md)**: Architectural invariants, zero-dependency server rules, UltraStar beat math, McLeod Pitch Method (MPM) DSP, and copyright protection guidelines.
