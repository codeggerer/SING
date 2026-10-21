# Architecture Decision Records (ADRs)

## Decision 2026-10-20: Spotify Color-Lyrics Token Strategy (Phase 2.2-A)

### Background
Spotify operates an internal endpoint `https://spclient.wg.spotify.com/color-lyrics/v2/track/{id}`.
We probed whether standard client-side PKCE OAuth tokens (issued for developer App Client IDs) or `sp_dc` web-player session tokens can authenticate to this internal endpoint.

### Probe Results
- **Track probed**: `4cOdK2wGLETKBW3PvgPWqT`
- **PKCE Token Probe**:
  - Tested: No (no token provided)
  - HTTP Status: N/A
  - Outcome: Rejected (401/403 or unavailable)
- **sp_dc Web-Player Token Probe**:
  - Tested: No (no sp_dc cookie provided)
  - HTTP Status: N/A
  - Outcome: Unavailable/Failed

### Architecture Decision
1. **Fallback Chain Priority**:
   - First attempt: PKCE access token forwarded from the client if present.
   - Second attempt: `sp_dc` web-player token exchange if configured in `config.local.json`.
   - If both fail or are unconfigured, smoothly fall through to LRCLIB and Whisper.
2. **Security & Invariants**:
   - `sp_dc` is stored exclusively in `config.local.json` (mode 0600, git-ignored).
   - The token and cookie are never exposed via API responses or web UI.
   - `/api/lyrics/status` exposes only boolean capability status: `{ spotifyLyricsMethod: "pkce" | "sp_dc" | null }`.

## Decision 2026-10-20: Spicy Lyrics API Schema & Rate Limits (Phase 2.2)

### Background & Discovery
The official Spicy Lyrics API documentation at `developers.spicylyrics.org` was protected by Cloudflare bot management, preventing automated schema scrapes. We authenticated live requests against `https://api.spicylyrics.org/v1/lyrics/{spotifyTrackId}` using a developer secret key.

### Empirical Discoveries
1. **Rate Limits**:
   - Headers observed: `ratelimit-limit: 60`, `ratelimit-remaining`, `ratelimit-reset`.
   - The API permits **60 requests per minute** per API key.
   - We configured our token bucket in `lib/lyrics.js` accordingly (1 req/s, burst cap 30/min, 60s window).
2. **Real Response Schema (Payload v1)**:
   - Root returns `{ Status: 200, Type: "object", Body: { ... } }`.
   - `Body.Type`: `"Syllable"` (highest precision) or `"Line"`.
   - `Body.StartTime` and `Body.EndTime`: floating-point numbers in **seconds** (not milliseconds).
   - `Body.Content`: array of vocal phrases containing:
     - `Lead.Syllables`: array of `{ Text, StartTime, EndTime, IsPartOfWord }`.
     - `Background`: array of background vocal tracks, each with its own `Syllables` array.
     - `IsPartOfWord`: boolean flag indicating whether the syllable attaches directly to the following syllable (corresponds to `joinNext: true` in `LyricsDoc`).
3. **Fixture Saved**:
   - A verified real payload for Queen's *Don't Stop Me Now* (`5T8EDUDqKcs6OSOwEsfqG7`) has been saved to [`tests/fixtures/spicylyrics_real_sample.json`](../tests/fixtures/spicylyrics_real_sample.json) and is tested in `tests/test_lyrics.js`.
