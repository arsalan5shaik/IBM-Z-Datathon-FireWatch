import type { Map as MapLibreMap } from 'maplibre-gl';

const PR = 2; // pixel ratio of generated icons

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w * PR;
  c.height = h * PR;
  const ctx = c.getContext('2d')!;
  ctx.scale(PR, PR);
  return { c, ctx };
}
const imageData = (c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(0, 0, c.width, c.height);

/** Wind arrow pointing north (rotated per feature). SDF so it can be tinted by speed. */
function windArrow() {
  const { c, ctx } = canvas(24, 24);
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.lineCap = 'round';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(12, 21);
  ctx.lineTo(12, 7);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(12, 2.5);
  ctx.lineTo(17, 10);
  ctx.lineTo(12, 8.4);
  ctx.lineTo(7, 10);
  ctx.closePath();
  ctx.fill();
  return imageData(c);
}

/** Rounded pill used behind weather labels (9-slice stretchable). */
function pill() {
  const w = 28, h = 22, r = 11;
  const { c, ctx } = canvas(w, h);
  ctx.shadowColor = 'rgba(15, 23, 42, 0.18)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.beginPath();
  ctx.roundRect(2, 2, w - 4, h - 5, r - 2);
  ctx.fill();
  return imageData(c);
}

export function addIcons(map: MapLibreMap) {
  if (!map.hasImage('fw-arrow')) map.addImage('fw-arrow', windArrow(), { pixelRatio: PR, sdf: true });
  if (!map.hasImage('fw-pill'))
    map.addImage('fw-pill', pill(), {
      pixelRatio: PR,
      stretchX: [[12 * PR, 16 * PR]],
      stretchY: [[10 * PR, 12 * PR]],
      content: [7 * PR, 4 * PR, 21 * PR, 15 * PR],
    });
}
