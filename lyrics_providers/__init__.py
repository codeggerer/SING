"""
lyrics_providers - Multi-Provider Lyrics Package for AI Karaoke Pipeline
(PLAN.md Phase 2)
"""

from lyrics_providers.models import Syllable, Line, LyricsDoc
from lyrics_providers.align_check import (
    compute_cer,
    estimate_audio_offset,
    verify_lyrics_against_audio,
)

__all__ = [
    "Syllable",
    "Line",
    "LyricsDoc",
    "compute_cer",
    "estimate_audio_offset",
    "verify_lyrics_against_audio",
]
