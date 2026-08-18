/**
 * Juva's palette. Paper and ink carry the layout, signal carries the money.
 *
 * `forest`, `blue` and `amber` are the per-retailer accents named by
 * `Store.colorToken`; their `*Soft` variants back the status chips.
 */
export const colors = {
  paper: '#F4F1E8',
  paperStrong: '#ECE7DB',
  ink: '#161A16',
  inkSoft: '#30372F',
  muted: '#737A70',
  border: '#D9D5C9',
  line: '#C9C5B9',
  forest: '#173C2A',
  forestSoft: '#DCE9DE',
  signal: '#C6F36B',
  signalDeep: '#50771B',
  amber: '#D9A438',
  amberSoft: '#F4E8C8',
  red: '#B64636',
  redSoft: '#F2DCD7',
  blue: '#587986',
  blueSoft: '#DDE8EA',
  white: '#FFFFFF',
  black: '#0B0D0B',
  cameraOverlay: 'rgba(8,12,8,0.34)',
} as const;
