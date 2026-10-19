/** Observatory colors and viewport surface. Geometry and evidence stay upstream. */
export const OBSERVATORY = Object.freeze({
  background: '#111E2E', ink: '#A7BFCD', accent: '#D1E9A2',
  ground: '#182838', edge: '#536978', path: '#101C29',
  lots: ['#243F47', '#293D52', '#423E4B', '#343B52', '#44463D'],
  canopies: [
    { face: '#9CA9B0', top: '#83AEA9', side: '#63727B', seam: '#45545F' },
    { face: '#8C9BA4', top: '#B2A0B9', side: '#5A6B77', seam: '#40515E' },
    { face: '#AAB5BB', top: '#A2B393', side: '#718089', seam: '#4F5F6A' },
    { face: '#95A3AC', top: '#C5B080', side: '#61737F', seam: '#435561' },
  ],
});

export function drawObservatorySurface(ctx, width, height) {
  ctx.save();
  ctx.fillStyle = OBSERVATORY.background;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#7696AE18';
  for (let x = 24; x < width; x += 32) {
    for (let y = 24; y < height; y += 32) ctx.fillRect(x, y, 1, 1);
  }
  ctx.restore();
}
