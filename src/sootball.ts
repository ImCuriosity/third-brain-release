// Sootball (숯검댕이) pixel art — 16×16 grid, pixel=8, viewBox 0 0 128 128
// mouth interior dark: #2e1065  eye white: #f2f2e8  body: #8B5CF6 (Obsidian 보라)

// 입 살짝 열고 기다리는 표정 (4px wide × 2px tall mouth)
export const SOOTBALL_WAITING = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="56" height="56" shape-rendering="crispEdges" class="tb-sootball-svg">
  <rect x="32" y="8"   width="16" height="8"  fill="#8B5CF6"/>
  <rect x="80" y="8"   width="16" height="8"  fill="#8B5CF6"/>
  <rect x="24" y="16"  width="80" height="8"  fill="#8B5CF6"/>
  <rect x="16" y="24"  width="96" height="8"  fill="#8B5CF6"/>
  <rect x="8"  y="32"  width="112" height="8" fill="#8B5CF6"/>
  <rect x="8"   y="40" width="16" height="8"  fill="#8B5CF6"/>
  <rect x="24"  y="40" width="16" height="8"  fill="#f2f2e8"/>
  <rect x="40"  y="40" width="48" height="8"  fill="#8B5CF6"/>
  <rect x="88"  y="40" width="16" height="8"  fill="#f2f2e8"/>
  <rect x="104" y="40" width="16" height="8"  fill="#8B5CF6"/>
  <rect x="8"   y="48" width="16" height="8"  fill="#8B5CF6"/>
  <rect x="24"  y="48" width="16" height="8"  fill="#f2f2e8"/>
  <rect x="40"  y="48" width="48" height="8"  fill="#8B5CF6"/>
  <rect x="88"  y="48" width="16" height="8"  fill="#f2f2e8"/>
  <rect x="104" y="48" width="16" height="8"  fill="#8B5CF6"/>
  <rect x="8"   y="56" width="112" height="8" fill="#8B5CF6"/>
  <rect x="8"   y="64" width="40" height="8"  fill="#8B5CF6"/>
  <rect x="80"  y="64" width="40" height="8"  fill="#8B5CF6"/>
  <rect x="48"  y="64" width="32" height="4"  fill="#8B5CF6"/>
  <rect x="48"  y="68" width="32" height="4"  fill="#2e1065"/>
  <rect x="8"   y="72" width="40" height="8"  fill="#8B5CF6"/>
  <rect x="80"  y="72" width="40" height="8"  fill="#8B5CF6"/>
  <rect x="48"  y="72" width="32" height="8"  fill="#2e1065"/>
  <rect x="8"   y="80" width="112" height="8" fill="#8B5CF6"/>
  <rect x="16"  y="88" width="96" height="8"  fill="#8B5CF6"/>
  <rect x="24"  y="96" width="80" height="8"  fill="#8B5CF6"/>
  <rect x="32"  y="104" width="16" height="8" fill="#8B5CF6"/>
  <rect x="80"  y="104" width="16" height="8" fill="#8B5CF6"/>
</svg>`;

// 입 쫘악 벌린 배고픈 표정 (10px wide × 3px tall mouth, 드래그 오버 시)
export const SOOTBALL_HUNGRY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="56" height="56" shape-rendering="crispEdges" class="tb-sootball-svg">
  <rect x="32" y="8"   width="16" height="8"  fill="#8B5CF6"/>
  <rect x="80" y="8"   width="16" height="8"  fill="#8B5CF6"/>
  <rect x="24" y="16"  width="80" height="8"  fill="#8B5CF6"/>
  <rect x="16" y="24"  width="96" height="8"  fill="#8B5CF6"/>
  <rect x="8"  y="32"  width="112" height="8" fill="#8B5CF6"/>
  <rect x="8"   y="40" width="16" height="8"  fill="#8B5CF6"/>
  <rect x="24"  y="40" width="16" height="8"  fill="#f2f2e8"/>
  <rect x="40"  y="40" width="48" height="8"  fill="#8B5CF6"/>
  <rect x="88"  y="40" width="16" height="8"  fill="#f2f2e8"/>
  <rect x="104" y="40" width="16" height="8"  fill="#8B5CF6"/>
  <rect x="8"   y="48" width="16" height="8"  fill="#8B5CF6"/>
  <rect x="24"  y="48" width="16" height="8"  fill="#f2f2e8"/>
  <rect x="40"  y="48" width="48" height="8"  fill="#8B5CF6"/>
  <rect x="88"  y="48" width="16" height="8"  fill="#f2f2e8"/>
  <rect x="104" y="48" width="16" height="8"  fill="#8B5CF6"/>
  <rect x="8"   y="56" width="112" height="8" fill="#8B5CF6"/>
  <rect x="8"   y="64" width="16" height="8"  fill="#8B5CF6"/>
  <rect x="104" y="64" width="16" height="8"  fill="#8B5CF6"/>
  <rect x="24"  y="64" width="80" height="4"  fill="#8B5CF6"/>
  <rect x="24"  y="68" width="80" height="4"  fill="#2e1065"/>
  <rect x="8"   y="72" width="16" height="24" fill="#8B5CF6"/>
  <rect x="104" y="72" width="16" height="24" fill="#8B5CF6"/>
  <rect x="24"  y="72" width="80" height="24" fill="#2e1065"/>
  <rect x="32"  y="88" width="8"  height="4"  fill="#4c1d95"/>
  <rect x="88"  y="88" width="8"  height="4"  fill="#4c1d95"/>
  <rect x="8"   y="96" width="112" height="8" fill="#8B5CF6"/>
  <rect x="16"  y="104" width="96" height="8" fill="#8B5CF6"/>
  <rect x="32"  y="112" width="16" height="8" fill="#8B5CF6"/>
  <rect x="80"  y="112" width="16" height="8" fill="#8B5CF6"/>
</svg>`;

// For Obsidian's addIcon(): inner SVG content, 100×100 coordinate space (pixel=6, offset=2)
export const SOOTBALL_ICON = `
  <rect x="26" y="8"  width="12" height="6" fill="#8B5CF6"/>
  <rect x="62" y="8"  width="12" height="6" fill="#8B5CF6"/>
  <rect x="20" y="14" width="60" height="6" fill="#8B5CF6"/>
  <rect x="14" y="20" width="72" height="6" fill="#8B5CF6"/>
  <rect x="8"  y="26" width="84" height="6" fill="#8B5CF6"/>
  <rect x="8"  y="32" width="12" height="6" fill="#8B5CF6"/>
  <rect x="20" y="32" width="12" height="6" fill="#f2f2e8"/>
  <rect x="32" y="32" width="36" height="6" fill="#8B5CF6"/>
  <rect x="68" y="32" width="12" height="6" fill="#f2f2e8"/>
  <rect x="80" y="32" width="12" height="6" fill="#8B5CF6"/>
  <rect x="8"  y="38" width="12" height="6" fill="#8B5CF6"/>
  <rect x="20" y="38" width="12" height="6" fill="#f2f2e8"/>
  <rect x="32" y="38" width="36" height="6" fill="#8B5CF6"/>
  <rect x="68" y="38" width="12" height="6" fill="#f2f2e8"/>
  <rect x="80" y="38" width="12" height="6" fill="#8B5CF6"/>
  <rect x="8"  y="44" width="84" height="24" fill="#8B5CF6"/>
  <rect x="14" y="68" width="72" height="6" fill="#8B5CF6"/>
  <rect x="20" y="74" width="60" height="6" fill="#8B5CF6"/>
  <rect x="26" y="80" width="12" height="6" fill="#8B5CF6"/>
  <rect x="62" y="80" width="12" height="6" fill="#8B5CF6"/>
`;

// 눈 찡그리고 V자 눈썹, 아랫방향 입꼬리, 머리 위 김 두 줄기 (미해소 모순 배지용)
export const SOOTBALL_ANGRY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="28" height="28" shape-rendering="crispEdges" class="tb-sootball-svg tb-sootball-angry">
  <rect x="20"  y="0"   width="16" height="8"  fill="#ff4500"/>
  <rect x="92"  y="0"   width="16" height="8"  fill="#ff4500"/>
  <rect x="32"  y="8"   width="16" height="8"  fill="#8B5CF6"/>
  <rect x="80"  y="8"   width="16" height="8"  fill="#8B5CF6"/>
  <rect x="24"  y="16"  width="80" height="8"  fill="#8B5CF6"/>
  <rect x="16"  y="24"  width="96" height="8"  fill="#8B5CF6"/>
  <rect x="8"   y="32"  width="112" height="8" fill="#8B5CF6"/>
  <rect x="8"   y="40"  width="16" height="8"  fill="#8B5CF6"/>
  <rect x="24"  y="40"  width="16" height="8"  fill="#f2f2e8"/>
  <rect x="40"  y="40"  width="48" height="8"  fill="#8B5CF6"/>
  <rect x="88"  y="40"  width="16" height="8"  fill="#f2f2e8"/>
  <rect x="104" y="40"  width="16" height="8"  fill="#8B5CF6"/>
  <rect x="32"  y="40"  width="8"  height="5"  fill="#8B5CF6"/>
  <rect x="88"  y="40"  width="8"  height="5"  fill="#8B5CF6"/>
  <rect x="8"   y="48"  width="112" height="8" fill="#8B5CF6"/>
  <rect x="8"   y="56"  width="112" height="8" fill="#8B5CF6"/>
  <rect x="8"   y="64"  width="112" height="16" fill="#8B5CF6"/>
  <rect x="48"  y="68"  width="32"  height="4" fill="#2e1065"/>
  <rect x="40"  y="72"  width="8"   height="4" fill="#2e1065"/>
  <rect x="80"  y="72"  width="8"   height="4" fill="#2e1065"/>
  <rect x="8"   y="80"  width="112" height="8" fill="#8B5CF6"/>
  <rect x="16"  y="88"  width="96"  height="8" fill="#8B5CF6"/>
  <rect x="24"  y="96"  width="80"  height="8" fill="#8B5CF6"/>
  <rect x="32"  y="104" width="16"  height="8" fill="#8B5CF6"/>
  <rect x="80"  y="104" width="16"  height="8" fill="#8B5CF6"/>
</svg>`;

// Full SVG for the settings tab logo (128×128, pixel=8)
export const SOOTBALL_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="64" height="64" shape-rendering="crispEdges" class="tb-sootball-svg">
  <rect x="32" y="8"   width="16" height="8" fill="#8B5CF6"/>
  <rect x="80" y="8"   width="16" height="8" fill="#8B5CF6"/>
  <rect x="24" y="16"  width="80" height="8" fill="#8B5CF6"/>
  <rect x="16" y="24"  width="96" height="8" fill="#8B5CF6"/>
  <rect x="8"  y="32"  width="112" height="8" fill="#8B5CF6"/>
  <rect x="8"  y="40"  width="16" height="8" fill="#8B5CF6"/>
  <rect x="24" y="40"  width="16" height="8" fill="#f2f2e8"/>
  <rect x="40" y="40"  width="48" height="8" fill="#8B5CF6"/>
  <rect x="88" y="40"  width="16" height="8" fill="#f2f2e8"/>
  <rect x="104" y="40" width="16" height="8" fill="#8B5CF6"/>
  <rect x="8"  y="48"  width="16" height="8" fill="#8B5CF6"/>
  <rect x="24" y="48"  width="16" height="8" fill="#f2f2e8"/>
  <rect x="40" y="48"  width="48" height="8" fill="#8B5CF6"/>
  <rect x="88" y="48"  width="16" height="8" fill="#f2f2e8"/>
  <rect x="104" y="48" width="16" height="8" fill="#8B5CF6"/>
  <rect x="8"  y="56"  width="112" height="32" fill="#8B5CF6"/>
  <rect x="16" y="88"  width="96" height="8" fill="#8B5CF6"/>
  <rect x="24" y="96"  width="80" height="8" fill="#8B5CF6"/>
  <rect x="32" y="104" width="16" height="8" fill="#8B5CF6"/>
  <rect x="80" y="104" width="16" height="8" fill="#8B5CF6"/>
</svg>`;
