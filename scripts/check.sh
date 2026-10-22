#!/usr/bin/env bash
# scripts/check.sh - Complete Regression Gate for SING Karaoke Engine (PLAN.md Phase 7.4)
#
# Runs:
# 1. Node.js unit tests (Resolver, Jobs Queue, Library API, and Engine MPM DSP)
# 2. Python AI pipeline unit tests (55 unit tests covering phonetics, pitch, melisma, and export)
# 3. Benchmark evaluation against baseline on fast 3-song corpus subset (fails if any metric regresses > 2%)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

echo "=========================================================="
echo "🛡️  RUNNING SING KARAOKE ENGINE REGRESSION GATE"
echo "=========================================================="

# 1. Node.js Test Suite
echo ""
echo "─── [1/3] JavaScript Engine & Gateway Unit Tests ───"
node tests/usdb_client_test.js
node tests/sync_test.js
node tests/resolver_test.js
node tests/jobs_test.js
node tests/settings_test.js
node tests/stem_mixer_test.js
node tests/pitch_tracking_test.js
node tests/highway_rendering_test.js
node tests/stage_arena_test.js
node tests/chart_editor_test.js
node tests/calibration_test.js
node tests/robustness_test.js
node tests/engine_test.js
node tests/test_lyrics.js
node tests/test_lyrics_harvester.js
node tests/phase5_paste_lyrics_test.js
node tests/tier2_precision_test.js
node tests/tier_consistency_phase5_test.js

# 2. Python Unit Tests
echo ""
echo "─── [2/3] Python AI Pipeline Unit Tests ───"
./venv/bin/python -m unittest discover tests

# 3. AI Benchmark Regression Gate on 3-Song Fast Subset
echo ""
echo "─── [3/3] AI Benchmark Regression Gate (fast/* subset) ───"
./venv/bin/python eval/eval.py --stage all --songs "fast/*" --check-regression eval/results/baseline.json

echo ""
echo "=========================================================="
echo "🎉 ALL TESTS & REGRESSION GATES PASSED CLEANLY!"
echo "=========================================================="
