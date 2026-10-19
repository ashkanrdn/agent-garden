export const INVALID_GARDEN_FILE = "This isn't an Agent Garden file — run the export script to make one.";

export function isGardenData(data) {
  return !!data && typeof data === 'object' && !Array.isArray(data)
    && data.schemaVersion === 1
    && ['sessions', 'projects', 'commits'].every(key => Array.isArray(data[key]));
}

export function gardenBaseURL(pageURL) {
  const url = new URL(pageURL);
  url.search = '';
  url.hash = '';
  // Static hosts serve a directory URL or an explicit index.html.
  url.pathname = url.pathname.replace(/\/index\.html?$/i, '/');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

export function buildExportCommand(pageURL) {
  const script = new URL('agent_garden_export.py', gardenBaseURL(pageURL)).href;
  // Quote unusual URL characters before exposing a command for a shell.
  const argument = /^[A-Za-z0-9_./:%~-]+$/.test(script) ? script : "'" + script.replace(/'/g, "'\\''") + "'";
  return 'curl -fsSL ' + argument + ' | python3 -';
}

export async function detectGardenMode(fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl('/api/status', { cache: 'no-store' });
    if (!response.ok) return 'hosted';
    await response.json();
    return 'local';
  } catch {
    return 'hosted';
  }
}

/** The only initial API request is detection. Hosted operations never send file data. */
export function createGardenDataSource({ pageURL, fetchImpl = globalThis.fetch }) {
  let mode = 'detecting', detection;
  const baseURL = gardenBaseURL(pageURL);
  return {
    get mode() { return mode; },
    baseURL,
    command: buildExportCommand(pageURL),
    initialize() {
      return detection ||= detectGardenMode(fetchImpl).then(result => (mode = result));
    },
    fetchLocal(url, options) {
      if (mode !== 'local') return Promise.resolve(null);
      return fetchImpl(url, options);
    },
    async readFile(file) {
      const data = JSON.parse(await file.text());
      if (!isGardenData(data)) throw Error(INVALID_GARDEN_FILE);
      return data;
    },
    async readDemo() {
      const response = await fetchImpl(new URL('demo/agent-garden-demo.json', baseURL).href, { cache: 'no-store' });
      if (!response.ok) throw Error('Demo unavailable');
      const data = await response.json();
      if (!isGardenData(data)) throw Error(INVALID_GARDEN_FILE);
      return data;
    },
  };
}

/** File selection, drag/drop, and arrival feedback. No persistent storage. */
export function mountGardenUpload({ source, onData, onMode, onLocal, pageURL,
  document = globalThis.document, clipboard = globalThis.navigator?.clipboard }) {
  const $ = id => document.getElementById(id);
  const arrival = $('garden-arrival'), input = $('garden-file'), status = $('upload-status');
  let generation = 0, dragDepth = 0;
  const showArrival = message => {
    arrival.hidden = false;
    status.textContent = message;
    document.body.dataset.gardenArrival = 'true';
  };
  const showData = data => {
    onData(data);
    arrival.hidden = true;
    status.textContent = '';
    document.body.dataset.gardenArrival = 'false';
    $('garden-support').hidden = false;
    // Do not leave keyboard focus inside the closed arrival panel.
    if (arrival.contains(document.activeElement)) $('data-summary').focus();
  };
  async function load(read, errorMessage) {
    const token = ++generation;
    status.textContent = 'Reading garden…';
    try {
      const data = await read();
      if (token === generation) showData(data);
    } catch {
      if (token === generation) showArrival(errorMessage);
    }
  }
  const openFile = file => load(() => source.readFile(file), INVALID_GARDEN_FILE);
  const openDemo = () => load(() => source.readDemo(), 'The demo garden is unavailable. Choose a file instead.');
  const hasFile = event => Array.from(event.dataTransfer?.types || []).includes('Files');
  const resetDrag = () => { dragDepth = 0; document.body.dataset.gardenDrop = 'false'; };

  $('export-command').textContent = source.command;
  $('export-script').href = new URL('agent_garden_export.py', source.baseURL).href;
  $('demo-garden').href = new URL('demo/agent-garden-demo.json', source.baseURL).href;
  $('copy-export').addEventListener('click', async () => {
    try {
      await clipboard.writeText(source.command);
      $('copy-export').textContent = 'Copied';
    } catch {
      const range = document.createRange();
      range.selectNodeContents($('export-command'));
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = 'Command selected. Copy it with your keyboard.';
    }
  });
  $('choose-garden-file').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file && source.mode === 'hosted') void openFile(file);
  });
  $('demo-garden').addEventListener('click', event => {
    event.preventDefault();
    if (source.mode === 'hosted') void openDemo();
  });
  document.addEventListener('dragenter', event => {
    if (source.mode !== 'hosted' || !hasFile(event)) return;
    event.preventDefault();
    dragDepth++;
    document.body.dataset.gardenDrop = 'true';
  });
  document.addEventListener('dragover', event => {
    if (source.mode !== 'hosted' || !hasFile(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) resetDrag(); });
  document.addEventListener('dragend', resetDrag);
  document.addEventListener('drop', event => {
    resetDrag();
    if (source.mode !== 'hosted' || !hasFile(event)) return;
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) void openFile(file);
  });

  return {
    chooseFile: () => input.click(),
    async start() {
      const mode = await source.initialize();
      document.body.dataset.gardenMode = mode;
      onMode(mode);
      if (mode === 'local') return onLocal();
      showArrival('');
      if (new URL(pageURL).searchParams.has('demo')) await openDemo();
    },
  };
}
