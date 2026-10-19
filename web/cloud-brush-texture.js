/** p5.brush is optional. All moving silhouettes remain ordinary Canvas paths. */
let texturePromise;
export function loadCloudPigment() {
  if (texturePromise) return texturePromise;
  texturePromise = generatePigment().catch(error => { texturePromise = null; throw error; });
  return texturePromise;
}

async function generatePigment() {
  const surface = document.createElement('canvas');
  surface.width = surface.height = 256;
  const gl = surface.getContext('webgl2', { preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2 is unavailable. Clean cloud shapes still work.');
  const started = performance.now();
  const brush = await import('./vendor/p5-brush-2.2.2/brush.esm.js');
  try {
    brush.load(surface);
    brush.seed(483765); brush.noiseSeed(483765);
    brush.clear(); brush.noStroke();
    brush.fill('#252525', 125);
    brush.fillBleed(.1, 'in', 0);
    brush.fillTexture(.7, .6, false);
    brush.polygon([[-123, -120], [120, -121], [124, 122], [-120, 123]]);
    brush.render();
    const cache = document.createElement('canvas');
    cache.width = cache.height = 256;
    const ctx = cache.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(surface, 0, 0);
    const pixels = ctx.getImageData(0, 0, 256, 256);
    let pigmentPixels = 0;
    // Brush fill opacity mixes pigment against white. Extract coverage once,
    // so white never becomes an opaque rectangle over the transparent clouds.
    for (let i = 0; i < pixels.data.length; i += 4) {
      const density = 1 - (pixels.data[i] + pixels.data[i + 1] + pixels.data[i + 2]) / 765;
      const alpha = Math.round(pixels.data[i + 3] * density);
      pixels.data[i] = 255; pixels.data[i + 1] = 224; pixels.data[i + 2] = 201;
      pixels.data[i + 3] = alpha;
      if (alpha > 0) pigmentPixels++;
    }
    if (!pigmentPixels) throw new Error('The brush returned an empty texture. Clean shapes still work.');
    ctx.putImageData(pixels, 0, 0);
    return { canvas: cache, generationMs: performance.now() - started, pigmentPixels, version: '2.2.2' };
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
