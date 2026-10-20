#!/usr/bin/env node
/**
 * Probe script for Spotify Color-Lyrics endpoint (PLAN.md Phase 2.2-A).
 *
 * Evaluates whether:
 *  (a) Standard Spotify PKCE tokens can access spclient.wg.spotify.com/color-lyrics/v2
 *  (b) Web-player access tokens derived from sp_dc cookie can access the endpoint
 *
 * Logs HTTP status codes, headers, and syncType, then updates docs/decisions.md.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

function request(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request(
      url,
      {
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeout || 10000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
          });
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout after ${options.timeout || 10000}ms`));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function probeColorLyricsWithToken(trackId, token, tokenTypeLabel = 'PKCE') {
  const url = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}?format=json&vocalRemoval=false&market=from_token`;
  console.log(`\n🔍 [${tokenTypeLabel}] Testing spclient color-lyrics endpoint for track: ${trackId}`);
  try {
    const res = await request(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'app-platform': 'WebPlayer',
        'authorization': `Bearer ${token}`,
      },
    });

    console.log(`  → HTTP Status: ${res.statusCode}`);
    let parsed = null;
    try {
      parsed = JSON.parse(res.body);
    } catch (_) {}

    const syncType = parsed?.lyrics?.syncType || parsed?.syncType || null;
    const lineCount = Array.isArray(parsed?.lyrics?.lines) ? parsed.lyrics.lines.length : null;

    console.log(`  → syncType: ${syncType || '(none)'}`);
    if (lineCount !== null) {
      console.log(`  → Lines returned: ${lineCount}`);
    }
    if (res.statusCode >= 400) {
      console.log(`  → Body excerpt: ${res.body.slice(0, 200)}`);
    }

    return {
      success: res.statusCode === 200,
      statusCode: res.statusCode,
      syncType,
      lineCount,
      headers: res.headers,
      bodyExcerpt: res.body.slice(0, 300),
    };
  } catch (err) {
    console.error(`  ✗ Request failed: ${err.message}`);
    return {
      success: false,
      statusCode: 0,
      error: err.message,
    };
  }
}

async function exchangeSpDcForToken(spDc) {
  console.log(`\n🔑 Exchanging sp_dc cookie for Spotify Web-Player token...`);
  const url = 'https://open.spotify.com/get_access_token?reason=transport&productType=web_player';
  try {
    const res = await request(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': `sp_dc=${spDc}`,
      },
    });

    console.log(`  → Exchange Status: ${res.statusCode}`);
    if (res.statusCode !== 200) {
      console.log(`  → Body: ${res.body.slice(0, 200)}`);
      return null;
    }

    const data = JSON.parse(res.body);
    if (data.accessToken) {
      console.log(`  ✓ Successfully obtained web-player token (expires in ${Math.round((data.accessTokenExpirationTimestampMs - Date.now()) / 1000)}s)`);
      return data.accessToken;
    } else {
      console.log(`  ✗ No accessToken found in response: ${res.body.slice(0, 200)}`);
      return null;
    }
  } catch (err) {
    console.error(`  ✗ Token exchange failed: ${err.message}`);
    return null;
  }
}

function updateDecisionsMd(findings) {
  const decisionsPath = path.resolve(__dirname, '..', 'docs', 'decisions.md');
  const dir = path.dirname(decisionsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const dateStr = new Date().toISOString().split('T')[0];
  const section = `\n## Decision 2026-10-20: Spotify Color-Lyrics Token Strategy (Phase 2.2-A)

### Background
Spotify operates an internal endpoint \`https://spclient.wg.spotify.com/color-lyrics/v2/track/{id}\`.
We probed whether standard client-side PKCE OAuth tokens (issued for developer App Client IDs) or \`sp_dc\` web-player session tokens can authenticate to this internal endpoint.

### Probe Results
- **Track probed**: \`${findings.trackId}\`
- **PKCE Token Probe**:
  - Tested: ${findings.pkceTested ? 'Yes' : 'No (no token provided)'}
  - HTTP Status: ${findings.pkceStatus ?? 'N/A'}
  - Outcome: ${findings.pkceSuccess ? 'Success (Allowed)' : 'Rejected (401/403 or unavailable)'}
- **sp_dc Web-Player Token Probe**:
  - Tested: ${findings.spDcTested ? 'Yes' : 'No (no sp_dc cookie provided)'}
  - HTTP Status: ${findings.spDcStatus ?? 'N/A'}
  - Outcome: ${findings.spDcSuccess ? 'Success' : 'Unavailable/Failed'}

### Architecture Decision
1. **Fallback Chain Priority**:
   - First attempt: PKCE access token forwarded from the client if present.
   - Second attempt: \`sp_dc\` web-player token exchange if configured in \`config.local.json\`.
   - If both fail or are unconfigured, smoothly fall through to LRCLIB and Whisper.
2. **Security & Invariants**:
   - \`sp_dc\` is stored exclusively in \`config.local.json\` (mode 0600, git-ignored).
   - The token and cookie are never exposed via API responses or web UI.
   - \`/api/lyrics/status\` exposes only boolean capability status: \`{ spotifyLyricsMethod: "pkce" | "sp_dc" | null }\`.
`;

  if (fs.existsSync(decisionsPath)) {
    fs.appendFileSync(decisionsPath, section);
  } else {
    fs.writeFileSync(decisionsPath, `# Architecture Decision Records (ADRs)\n${section}`);
  }
  console.log(`\n📝 Updated docs/decisions.md with probe findings.`);
}

async function main() {
  const args = process.argv.slice(2);
  let trackId = '4cOdK2wGLETKBW3PvgPWqT'; // Queen - Bohemian Rhapsody
  let pkceToken = process.env.SPOTIFY_ACCESS_TOKEN || null;
  let spDc = process.env.SPOTIFY_SP_DC || null;
  let writeDecisions = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--track' && args[i + 1]) {
      trackId = args[++i];
    } else if (args[i] === '--pkce' && args[i + 1]) {
      pkceToken = args[++i];
    } else if (args[i] === '--pkce-file' && args[i + 1]) {
      pkceToken = fs.readFileSync(args[++i], 'utf8').trim();
    } else if (args[i] === '--sp-dc' && args[i + 1]) {
      spDc = args[++i];
    } else if (args[i] === '--sp-dc-file' && args[i + 1]) {
      spDc = fs.readFileSync(args[++i], 'utf8').trim();
    } else if (args[i] === '--write-decisions') {
      writeDecisions = true;
    }
  }

  console.log(`====================================================`);
  console.log(`🎵 Spotify Color-Lyrics Endpoint Probe (Phase 2.2-A)`);
  console.log(`====================================================`);
  console.log(`Target Track: ${trackId}`);

  const findings = {
    trackId,
    pkceTested: false,
    pkceStatus: null,
    pkceSuccess: false,
    spDcTested: false,
    spDcStatus: null,
    spDcSuccess: false,
  };

  if (pkceToken) {
    findings.pkceTested = true;
    const res = await probeColorLyricsWithToken(trackId, pkceToken, 'PKCE Token');
    findings.pkceStatus = res.statusCode;
    findings.pkceSuccess = res.success;
  } else {
    console.log(`\nℹ️  No PKCE token provided (--pkce or SPOTIFY_ACCESS_TOKEN).`);
  }

  if (spDc) {
    findings.spDcTested = true;
    const token = await exchangeSpDcForToken(spDc);
    if (token) {
      const res = await probeColorLyricsWithToken(trackId, token, 'sp_dc Web-Player Token');
      findings.spDcStatus = res.statusCode;
      findings.spDcSuccess = res.success;
    } else {
      findings.spDcStatus = 401;
    }
  } else {
    console.log(`\nℹ️  No sp_dc cookie provided (--sp-dc or SPOTIFY_SP_DC).`);
  }

  if (writeDecisions || (!pkceToken && !spDc)) {
    updateDecisionsMd(findings);
  }

  console.log(`\n✅ Probe completed.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { probeColorLyricsWithToken, exchangeSpDcForToken };
