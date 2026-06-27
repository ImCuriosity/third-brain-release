// Sootball (숯검댕이) pixel art — 16×16 grid, pixel=8, viewBox 0 0 128 128
// mouth interior dark: #1a0808  eye white: #f2f2e8  body: #2b2b2b

// 입 살짝 열고 기다리는 표정 (4px wide × 2px tall mouth)
export const SOOTBALL_WAITING = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="56" height="56" shape-rendering="crispEdges" style="image-rendering:pixelated">
  <rect x="32" y="8"   width="16" height="8"  fill="#2b2b2b"/>
  <rect x="80" y="8"   width="16" height="8"  fill="#2b2b2b"/>
  <rect x="24" y="16"  width="80" height="8"  fill="#2b2b2b"/>
  <rect x="16" y="24"  width="96" height="8"  fill="#2b2b2b"/>
  <rect x="8"  y="32"  width="112" height="8" fill="#2b2b2b"/>
  <rect x="8"   y="40" width="16" height="8"  fill="#2b2b2b"/>
  <rect x="24"  y="40" width="16" height="8"  fill="#f2f2e8"/>
  <rect x="40"  y="40" width="48" height="8"  fill="#2b2b2b"/>
  <rect x="88"  y="40" width="16" height="8"  fill="#f2f2e8"/>
  <rect x="104" y="40" width="16" height="8"  fill="#2b2b2b"/>
  <rect x="8"   y="48" width="16" height="8"  fill="#2b2b2b"/>
  <rect x="24"  y="48" width="16" height="8"  fill="#f2f2e8"/>
  <rect x="40"  y="48" width="48" height="8"  fill="#2b2b2b"/>
  <rect x="88"  y="48" width="16" height="8"  fill="#f2f2e8"/>
  <rect x="104" y="48" width="16" height="8"  fill="#2b2b2b"/>
  <rect x="8"   y="56" width="112" height="8" fill="#2b2b2b"/>
  <rect x="8"   y="64" width="40" height="8"  fill="#2b2b2b"/>
  <rect x="80"  y="64" width="40" height="8"  fill="#2b2b2b"/>
  <rect x="48"  y="64" width="32" height="4"  fill="#2b2b2b"/>
  <rect x="48"  y="68" width="32" height="4"  fill="#1a0808"/>
  <rect x="8"   y="72" width="40" height="8"  fill="#2b2b2b"/>
  <rect x="80"  y="72" width="40" height="8"  fill="#2b2b2b"/>
  <rect x="48"  y="72" width="32" height="8"  fill="#1a0808"/>
  <rect x="8"   y="80" width="112" height="8" fill="#2b2b2b"/>
  <rect x="16"  y="88" width="96" height="8"  fill="#2b2b2b"/>
  <rect x="24"  y="96" width="80" height="8"  fill="#2b2b2b"/>
  <rect x="32"  y="104" width="16" height="8" fill="#2b2b2b"/>
  <rect x="80"  y="104" width="16" height="8" fill="#2b2b2b"/>
</svg>`;

// 입 쫘악 벌린 배고픈 표정 (10px wide × 3px tall mouth, 드래그 오버 시)
export const SOOTBALL_HUNGRY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="56" height="56" shape-rendering="crispEdges" style="image-rendering:pixelated">
  <rect x="32" y="8"   width="16" height="8"  fill="#2b2b2b"/>
  <rect x="80" y="8"   width="16" height="8"  fill="#2b2b2b"/>
  <rect x="24" y="16"  width="80" height="8"  fill="#2b2b2b"/>
  <rect x="16" y="24"  width="96" height="8"  fill="#2b2b2b"/>
  <rect x="8"  y="32"  width="112" height="8" fill="#2b2b2b"/>
  <rect x="8"   y="40" width="16" height="8"  fill="#2b2b2b"/>
  <rect x="24"  y="40" width="16" height="8"  fill="#f2f2e8"/>
  <rect x="40"  y="40" width="48" height="8"  fill="#2b2b2b"/>
  <rect x="88"  y="40" width="16" height="8"  fill="#f2f2e8"/>
  <rect x="104" y="40" width="16" height="8"  fill="#2b2b2b"/>
  <rect x="8"   y="48" width="16" height="8"  fill="#2b2b2b"/>
  <rect x="24"  y="48" width="16" height="8"  fill="#f2f2e8"/>
  <rect x="40"  y="48" width="48" height="8"  fill="#2b2b2b"/>
  <rect x="88"  y="48" width="16" height="8"  fill="#f2f2e8"/>
  <rect x="104" y="48" width="16" height="8"  fill="#2b2b2b"/>
  <rect x="8"   y="56" width="112" height="8" fill="#2b2b2b"/>
  <rect x="8"   y="64" width="16" height="8"  fill="#2b2b2b"/>
  <rect x="104" y="64" width="16" height="8"  fill="#2b2b2b"/>
  <rect x="24"  y="64" width="80" height="4"  fill="#2b2b2b"/>
  <rect x="24"  y="68" width="80" height="4"  fill="#1a0808"/>
  <rect x="8"   y="72" width="16" height="24" fill="#2b2b2b"/>
  <rect x="104" y="72" width="16" height="24" fill="#2b2b2b"/>
  <rect x="24"  y="72" width="80" height="24" fill="#1a0808"/>
  <rect x="32"  y="88" width="8"  height="4"  fill="#3a1818"/>
  <rect x="88"  y="88" width="8"  height="4"  fill="#3a1818"/>
  <rect x="8"   y="96" width="112" height="8" fill="#2b2b2b"/>
  <rect x="16"  y="104" width="96" height="8" fill="#2b2b2b"/>
  <rect x="32"  y="112" width="16" height="8" fill="#2b2b2b"/>
  <rect x="80"  y="112" width="16" height="8" fill="#2b2b2b"/>
</svg>`;



// For Obsidian's addIcon(): inner SVG content, 100×100 coordinate space (pixel=6, offset=2)
export const SOOTBALL_ICON = `
  <rect x="26" y="8"  width="12" height="6" fill="#2b2b2b"/>
  <rect x="62" y="8"  width="12" height="6" fill="#2b2b2b"/>
  <rect x="20" y="14" width="60" height="6" fill="#2b2b2b"/>
  <rect x="14" y="20" width="72" height="6" fill="#2b2b2b"/>
  <rect x="8"  y="26" width="84" height="6" fill="#2b2b2b"/>
  <rect x="8"  y="32" width="12" height="6" fill="#2b2b2b"/>
  <rect x="20" y="32" width="12" height="6" fill="#f2f2e8"/>
  <rect x="32" y="32" width="36" height="6" fill="#2b2b2b"/>
  <rect x="68" y="32" width="12" height="6" fill="#f2f2e8"/>
  <rect x="80" y="32" width="12" height="6" fill="#2b2b2b"/>
  <rect x="8"  y="38" width="12" height="6" fill="#2b2b2b"/>
  <rect x="20" y="38" width="12" height="6" fill="#f2f2e8"/>
  <rect x="32" y="38" width="36" height="6" fill="#2b2b2b"/>
  <rect x="68" y="38" width="12" height="6" fill="#f2f2e8"/>
  <rect x="80" y="38" width="12" height="6" fill="#2b2b2b"/>
  <rect x="8"  y="44" width="84" height="24" fill="#2b2b2b"/>
  <rect x="14" y="68" width="72" height="6" fill="#2b2b2b"/>
  <rect x="20" y="74" width="60" height="6" fill="#2b2b2b"/>
  <rect x="26" y="80" width="12" height="6" fill="#2b2b2b"/>
  <rect x="62" y="80" width="12" height="6" fill="#2b2b2b"/>
`;

// Full SVG for the settings tab logo (128×128, pixel=8)
export const SOOTBALL_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="64" height="64" shape-rendering="crispEdges" style="image-rendering:pixelated">
  <rect x="32" y="8"   width="16" height="8" fill="#2b2b2b"/>
  <rect x="80" y="8"   width="16" height="8" fill="#2b2b2b"/>
  <rect x="24" y="16"  width="80" height="8" fill="#2b2b2b"/>
  <rect x="16" y="24"  width="96" height="8" fill="#2b2b2b"/>
  <rect x="8"  y="32"  width="112" height="8" fill="#2b2b2b"/>
  <rect x="8"  y="40"  width="16" height="8" fill="#2b2b2b"/>
  <rect x="24" y="40"  width="16" height="8" fill="#f2f2e8"/>
  <rect x="40" y="40"  width="48" height="8" fill="#2b2b2b"/>
  <rect x="88" y="40"  width="16" height="8" fill="#f2f2e8"/>
  <rect x="104" y="40" width="16" height="8" fill="#2b2b2b"/>
  <rect x="8"  y="48"  width="16" height="8" fill="#2b2b2b"/>
  <rect x="24" y="48"  width="16" height="8" fill="#f2f2e8"/>
  <rect x="40" y="48"  width="48" height="8" fill="#2b2b2b"/>
  <rect x="88" y="48"  width="16" height="8" fill="#f2f2e8"/>
  <rect x="104" y="48" width="16" height="8" fill="#2b2b2b"/>
  <rect x="8"  y="56"  width="112" height="32" fill="#2b2b2b"/>
  <rect x="16" y="88"  width="96" height="8" fill="#2b2b2b"/>
  <rect x="24" y="96"  width="80" height="8" fill="#2b2b2b"/>
  <rect x="32" y="104" width="16" height="8" fill="#2b2b2b"/>
  <rect x="80" y="104" width="16" height="8" fill="#2b2b2b"/>
</svg>`;
