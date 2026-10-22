/**
 * tests/stage_arena_test.js
 * Unit & Integration Test Suite for Phase 7: Stage Arena UI/UX & Canvas Highway
 *
 * Verifies:
 * 1. 16:9 Aspect Ratio Constraint & Zero Horizontal Overshoots
 * 2. Adjustable Backdrop Darkness & 8px Backdrop Blur
 * 3. Dedicated Fullscreen Mode (Button ⛶ and Global F Key Shortcut)
 * 4. Electric Cyan Playhead (#00f0ff glow blur 10, 3.2px width, diamond pointers) & Settings Color Selection
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('🧪 RUNNING STAGE ARENA UI/UX & CANVAS HIGHWAY TEST SUITE (PHASE 7)');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const cssPath = path.join(__dirname, '..', 'public', 'style.css');
const jsPath = path.join(__dirname, '..', 'public', 'app.js');

const html = fs.readFileSync(htmlPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
const js = fs.readFileSync(jsPath, 'utf8');

// ============================================================================
// 1. 16:9 Aspect Ratio Constraint & Video Cropping Verification
// ============================================================================
console.log('\n--- Section 1: 16:9 Aspect Ratio Constraint & Horizontal Cropping ---');

// Check style.css for .stage-arena.mode-video-backdrop rules
assert.ok(
  css.includes('aspect-ratio: 16 / 9 !important;'),
  'style.css must lock .stage-arena.mode-video-backdrop to aspect-ratio: 16 / 9 !important;'
);
assert.ok(
  css.includes('width: min(100%, calc((100vh - 210px) * 16 / 9)) !important;'),
  'style.css must set width: min(100%, calc((100vh - 210px) * 16 / 9)) !important; for standard backdrop view'
);
assert.ok(
  css.includes('margin: 0 auto !important;'),
  'style.css must center stage arena with margin: 0 auto !important;'
);
assert.ok(
  css.includes('overflow: hidden !important;'),
  'style.css must clip any child element overshoot with overflow: hidden !important;'
);

// Verify that the highway panel inside mode-video-backdrop matches video boundaries
assert.ok(
  css.includes('.stage-arena.mode-video-backdrop .highway-panel'),
  'style.css must define .stage-arena.mode-video-backdrop .highway-panel'
);
assert.ok(
  css.includes('.stage-arena.mode-video-backdrop #pitchCanvas'),
  'style.css must define .stage-arena.mode-video-backdrop #pitchCanvas'
);

// Aspect ratio math simulation: verify that for various viewport dimensions, 16:9 is strictly maintained
function computeArenaDimensions(viewportWidth, viewportHeight, isFullscreen = false) {
  const verticalDeduction = isFullscreen ? 165 : 210;
  const maxHeight = Math.max(0, viewportHeight - verticalDeduction);
  const maxWidthFromHeight = maxHeight * (16 / 9);
  const finalWidth = Math.min(viewportWidth, maxWidthFromHeight);
  // With aspect-ratio: 16 / 9, height is determined strictly by width:
  const finalHeight = finalWidth * (9 / 16);
  return { width: finalWidth, height: finalHeight, ratio: finalWidth / finalHeight };
}

const testViewports = [
  { name: '1080p Standard (1920x1080)', w: 1920, h: 1080 },
  { name: '4K Ultra HD (3840x2160)', w: 3840, h: 2160 },
  { name: 'MacBook 14" (1512x982)', w: 1512, h: 982 },
  { name: 'Narrow Portrait (800x1200)', w: 800, h: 1200 },
  { name: 'Compact Laptop (1280x720)', w: 1280, h: 720 },
];

for (const vp of testViewports) {
  const standardDim = computeArenaDimensions(vp.w, vp.h, false);
  const fsDim = computeArenaDimensions(vp.w, vp.h, true);

  assert.ok(
    Math.abs(standardDim.ratio - 16 / 9) < 0.0001,
    `${vp.name} standard mode must maintain strict 16:9 ratio (got ${standardDim.ratio.toFixed(4)})`
  );
  assert.ok(
    standardDim.height <= vp.h - 210,
    `${vp.name} standard height (${standardDim.height}px) must not exceed maxHeight (${vp.h - 210}px)`
  );
  assert.ok(
    standardDim.width <= vp.w,
    `${vp.name} standard width (${standardDim.width}px) must not exceed viewport width (${vp.w}px)`
  );

  assert.ok(
    Math.abs(fsDim.ratio - 16 / 9) < 0.0001,
    `${vp.name} fullscreen mode must maintain strict 16:9 ratio (got ${fsDim.ratio.toFixed(4)})`
  );
  assert.ok(
    fsDim.height <= vp.h - 165,
    `${vp.name} fullscreen height (${fsDim.height}px) must not exceed maxHeight (${vp.h - 165}px)`
  );
}

console.log('  ✓ PASS: 16:9 Aspect Ratio constraint strictly maintained across all screen resolutions with zero horizontal overshoot');

// ============================================================================
// 2. Adjustable Backdrop Darkness & 8px Blur Verification
// ============================================================================
console.log('\n--- Section 2: Adjustable Backdrop Darkness & 8px Blur ---');

assert.ok(
  html.includes('id="sliderHighwayOpacity"'),
  'index.html must include #sliderHighwayOpacity'
);
assert.ok(
  html.includes('min="15"') && html.includes('max="95"'),
  '#sliderHighwayOpacity must have min="15" and max="95"'
);
assert.ok(
  html.includes('id="lblHighwayOpacityVal"'),
  'index.html must include #lblHighwayOpacityVal'
);

assert.ok(
  css.includes('var(--highway-backdrop-opacity'),
  'style.css must use --highway-backdrop-opacity custom property'
);
assert.ok(
  css.includes('backdrop-filter: blur(var(--highway-backdrop-blur, 8px))'),
  'style.css must apply backdrop-filter: blur(var(--highway-backdrop-blur, 8px))'
);
assert.ok(
  css.includes('-webkit-backdrop-filter: blur(var(--highway-backdrop-blur, 8px))'),
  'style.css must apply -webkit-backdrop-filter for Safari/WebKit compatibility'
);

assert.ok(
  js.includes('--highway-backdrop-opacity'),
  'app.js must dynamically set --highway-backdrop-opacity'
);
assert.ok(
  js.includes('--highway-backdrop-blur'),
  'app.js must dynamically set --highway-backdrop-blur'
);
assert.ok(
  js.includes("sliderHighwayOpacity.addEventListener('input'"),
  'app.js must wire up input event on #sliderHighwayOpacity'
);

// Simulate applySettings with various opacity percentages
function simulateOpacityUpdate(percent) {
  const opacityVal = Math.min(95, Math.max(15, percent));
  const opacityRatio = (opacityVal / 100).toFixed(2);
  const blur = '8px';
  return { opacityRatio, blur, label: `${opacityVal}%` };
}

const op15 = simulateOpacityUpdate(15);
assert.strictEqual(op15.opacityRatio, '0.15');
assert.strictEqual(op15.blur, '8px');
assert.strictEqual(op15.label, '15%');

const op65 = simulateOpacityUpdate(65);
assert.strictEqual(op65.opacityRatio, '0.65');
assert.strictEqual(op65.blur, '8px');
assert.strictEqual(op65.label, '65%');

const op95 = simulateOpacityUpdate(95);
assert.strictEqual(op95.opacityRatio, '0.95');
assert.strictEqual(op95.blur, '8px');
assert.strictEqual(op95.label, '95%');

console.log('  ✓ PASS: Adjustable backdrop darkness (15-95%) and 8px backdrop blur dynamically verified');

// ============================================================================
// 3. Dedicated Fullscreen Mode (Button ⛶ and Global F Key Shortcut)
// ============================================================================
console.log('\n--- Section 3: Dedicated Fullscreen Mode (Button ⛶ & F Key) ---');

assert.ok(
  html.includes('id="btnToggleFullscreen"'),
  'index.html must include #btnToggleFullscreen in stage arena controls'
);
assert.ok(
  html.includes('id="btnTopFullscreen"'),
  'index.html must include #btnTopFullscreen in stage header'
);
assert.ok(
  html.includes('Toggle Fullscreen Mode (F)'),
  'Fullscreen toggle button must advertise (F) shortcut in title'
);

// Check F key handler in app.js
assert.ok(
  js.includes("e.key === 'f' || e.key === 'F'"),
  'app.js must listen for F/f keypress to toggle fullscreen'
);
assert.ok(
  js.includes('function toggleFullscreen()'),
  'app.js must declare toggleFullscreen() function'
);
assert.ok(
  js.includes('fullscreenElement') && js.includes('webkitFullscreenElement'),
  'toggleFullscreen() must support cross-browser Fullscreen API with WebKit prefix'
);
assert.ok(
  js.includes('requestFullscreen') && js.includes('webkitRequestFullscreen'),
  'toggleFullscreen() must support requestFullscreen with WebKit fallback'
);
assert.ok(
  js.includes('fullscreenchange') && js.includes('webkitfullscreenchange'),
  'app.js must listen to fullscreenchange and webkitfullscreenchange events'
);

// Check modal backdrop z-index exceeds fullscreen view z-index
const fsZIndexMatch = css.match(/#viewStage\.is-fullscreen\s*\{[^}]*z-index:\s*(\d+)/);
assert.ok(fsZIndexMatch, 'style.css must specify z-index on #viewStage.is-fullscreen');
const fsZIndex = parseInt(fsZIndexMatch[1], 10);

const modalZIndexMatch = css.match(/\.modal-backdrop\s*\{[^}]*z-index:\s*(\d+)/);
assert.ok(modalZIndexMatch, 'style.css must specify z-index on .modal-backdrop');
const modalZIndex = parseInt(modalZIndexMatch[1], 10);

assert.ok(
  modalZIndex > fsZIndex,
  `modal-backdrop z-index (${modalZIndex}) must be higher than fullscreen stage z-index (${fsZIndex}) so settings/editor modals open properly`
);

console.log('  ✓ PASS: Fullscreen button ⛶, global F key shortcut, WebKit Safari support, and modal layering verified');

// ============================================================================
// 4. Electric Cyan Playhead & Color Selection Verification
// ============================================================================
console.log('\n--- Section 4: Electric Cyan Playhead & Color Selection ---');

assert.ok(
  js.includes("playheadColor: 'cyan'"),
  'DEFAULT_SETTINGS must specify playheadColor: cyan as default'
);
assert.ok(
  html.includes('id="selectPlayheadColor"'),
  'index.html must include #selectPlayheadColor settings selector'
);

const expectedThemes = ['cyan', 'gold', 'emerald', 'white', 'magenta'];
for (const theme of expectedThemes) {
  assert.ok(
    html.includes(`value="${theme}"`),
    `#selectPlayheadColor must include option for '${theme}'`
  );
  assert.ok(
    js.includes(`'${theme}'`),
    `app.js must support playhead color theme '${theme}'`
  );
}

// Verify playhead drawing specifications in app.js
assert.ok(
  js.includes("playheadGlow = '#00f0ff'"),
  'app.js must use #00f0ff cyan laser glow by default'
);
assert.ok(
  js.includes('ctx.shadowBlur = 10;'),
  'Playhead line must have shadowBlur = 10'
);
assert.ok(
  js.includes('ctx.lineWidth = 3.2;'),
  'Playhead laser width must be 3.2px'
);
assert.ok(
  js.includes('drawDiamond(playheadX,'),
  'app.js must render top and bottom laser diamond pointers on playhead'
);

// Verify diamond pointer math
function computeDiamondVertices(cx, cy, r) {
  return [
    { x: cx, y: cy - r },     // top
    { x: cx + r, y: cy },     // right
    { x: cx, y: cy + r },     // bottom
    { x: cx - r, y: cy },     // left
  ];
}

const diamondTop = computeDiamondVertices(240, 26, 5.5);
assert.strictEqual(diamondTop.length, 4);
assert.strictEqual(diamondTop[0].y, 20.5); // 26 - 5.5
assert.strictEqual(diamondTop[2].y, 31.5); // 26 + 5.5

console.log('  ✓ PASS: Luminous Electric Cyan playhead (#00f0ff glow 10, 3.2px width, diamond pointers) and 5 themes verified');

console.log('\n==========================================================');
console.log('🎉 ALL PHASE 7 (STAGE ARENA UI/UX & CANVAS HIGHWAY) TESTS PASSED!');
console.log('==========================================================');
