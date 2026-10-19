// Arrival identity is independent of camera motion and tree animation settings.
export function createSpawnCardQueue(limit = 20) {
  let seen = null, cards = [];
  const newestFirst = (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || a.id.localeCompare(b.id);
  return {
    sync(records, { reset = false, notify = true } = {}) {
      const byId = new Map(records.map(record => [record.id, record]));
      const ordered = [...byId.values()].sort(newestFirst);
      const arrivals = seen && !reset ? ordered.filter(record => !seen.has(record.id)) : [];
      cards = ordered.slice(0, limit);
      seen = new Set(byId.keys());
      return { cards: [...cards], arrivals: notify ? arrivals : [] };
    },
  };
}

export function spawnCardRecord(session, project, agent) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    project: project?.name || 'Unknown project',
    title: session.title || 'Untitled session',
    branch: session.gitContext?.branch || 'Branch unavailable',
    model: agent?.model || session.model || 'Model unavailable',
  };
}

export function createSpawnCardStack({ host, onSelect }) {
  const queue = createSpawnCardQueue(), nodes = new Map();
  const document = host.ownerDocument;
  const list = host.querySelector('ol'), announcement = host.querySelector('[role="status"]');
  const context = host.querySelector('[data-spawn-context]');
  const toggle = host.querySelector('[data-spawn-toggle]');
  toggle?.addEventListener('click', () => {
    const collapsed = host.dataset.collapsed !== 'true';
    host.dataset.collapsed = String(collapsed);
    list.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand recent trees' : 'Collapse recent trees');
  });
  let mode = null, hovered = false, focused = false, pending = null;
  // Keep cards in place while someone reads or selects them. No expiry timer.
  host.addEventListener('pointerenter', () => { hovered = true; });
  host.addEventListener('pointerleave', () => { hovered = false; flush(); });
  host.addEventListener('focusin', () => { focused = true; });
  host.addEventListener('focusout', event => { focused = host.contains(event.relatedTarget); flush(); });
  for (const event of ['pointerdown', 'click', 'dblclick', 'wheel']) host.addEventListener(event, event => event.stopPropagation());

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function createCard(card) {
    const item = element('li', 'spawn-card');
    const button = element('button', 'spawn-card-open');
    button.type = 'button';
    const top = element('span', 'spawn-card-top');
    const project = element('span', 'spawn-card-project');
    const mark = element('span', 'spawn-card-mark', '↗');
    mark.setAttribute('aria-hidden', 'true');
    top.append(project, mark);
    const title = element('strong', 'spawn-card-title');
    const branch = element('span', 'spawn-card-value');
    const branchRow = element('span', 'spawn-card-row');
    branchRow.append(element('span', 'spawn-card-label', 'Branch'), branch);
    const model = element('span', 'spawn-card-value');
    const modelRow = element('span', 'spawn-card-row');
    modelRow.append(element('span', 'spawn-card-label', 'Model'), model);
    button.append(top, title, branchRow, modelRow);
    button.addEventListener('click', () => onSelect(card.id));
    item.append(button);
    item.dataset.session = card.id;
    return { item, button, project, title, branch, model };
  }

  function render({ cards, arrivals, motion, mode, reset }) {
    const scroll = host.scrollTop || 0;
    const step = list.children.length ? list.offsetHeight / list.children.length : 0;
    const anchorSlot = step ? Math.min(list.children.length - 1, Math.floor(scroll / step)) : 0;
    const anchorId = list.children[anchorSlot]?.dataset.session;
    // Keep the same card at the same reading position when arrivals prepend.
    const animate = motion && !reset && scroll < 1;
    host.hidden = !cards.length;
    host.dataset.motion = String(animate);
    context.textContent = mode === 'live' ? 'Live' : 'History';
    const keep = new Set(cards.map(card => card.id));
    for (const [id, node] of nodes) if (!keep.has(id)) { node.item.remove(); nodes.delete(id); }
    const entered = [];
    for (const [index, card] of cards.entries()) {
      let node = nodes.get(card.id);
      if (!node) {
        node = createCard(card);
        nodes.set(card.id, node);
        if (animate && arrivals.some(arrival => arrival.id === card.id)) {
          node.item.dataset.entering = 'true';
          entered.push(node.item);
        }
      }
      for (const field of ['project', 'title', 'branch', 'model']) {
        if (node[field].textContent !== card[field]) node[field].textContent = card[field];
        node[field].title = card[field];
      }
      node.button.setAttribute('aria-label', `Fly to ${card.title}. Project ${card.project}. Branch ${card.branch}. Model ${card.model}.`);
      node.item.style.setProperty('--slot', index);
      if (list.children[index] !== node.item) list.insertBefore(node.item, list.children[index] || null);
    }
    list.style.setProperty('--card-count', cards.length);
    if (reset) host.scrollTop = 0;
    else if (scroll > 0 && step) {
      const nextSlot = cards.findIndex(card => card.id === anchorId);
      if (nextSlot >= 0) host.scrollTop = scroll + (nextSlot - anchorSlot) * step;
    }
    if (entered.length) {
      // Commit only the entry state; subsequent position changes use interruptible transitions.
      void list.offsetHeight;
      for (const item of entered) delete item.dataset.entering;
    }
    announcement.textContent = arrivals.length === 1
      ? `New tree: ${arrivals[0].project}. ${arrivals[0].title}. Branch ${arrivals[0].branch}. Model ${arrivals[0].model}.`
      : arrivals.length ? `${arrivals.length} new trees. Latest: ${cards[0].project}, ${cards[0].title}.` : '';
  }

  function flush() {
    if (!hovered && !focused && pending) { const next = pending; pending = null; render(next); }
  }

  return {
    sync(records, options = {}) {
      const reset = options.reset || mode !== options.mode;
      mode = options.mode;
      const result = { ...queue.sync(records, { ...options, reset }), ...options, reset };
      if (!reset && (hovered || focused)) {
        // Retain arrival notices if a metadata-only event follows while reading.
        if (pending?.arrivals.length && !result.arrivals.length) result.arrivals = pending.arrivals;
        pending = result;
      } else { pending = null; render(result); }
    },
  };
}
