/** In-memory paging for the selected agent. Message text never enters garden data. */
export function createGardenMessagePager({ fetchPage, onChange = () => {} }) {
  let rootId = null, agentId = null, messages = [], nextCursor = null;
  let generation = 0, olderLoading = false, error = null;
  const emit = options => onChange({ rootId, agentId, messages: [...messages], nextCursor, error }, options);
  const sameSelection = (root, agent) => rootId === root && agentId === agent;
  const unique = items => {
    const seen = new Set();
    return items.filter(item => item?.id && !seen.has(item.id) && seen.add(item.id));
  };

  async function refresh() {
    if (!rootId || !agentId) return;
    const token = ++generation, root = rootId, agent = agentId;
    const boundary = messages[0]?.id;
    let incoming = [], cursor = null, overlap = false;
    const visited = new Set();
    try {
      do {
        const page = await fetchPage(root, agent, cursor);
        if (token !== generation || !sameSelection(root, agent)) return;
        incoming = unique([...incoming, ...(page.messages || [])]);
        overlap = !!boundary && incoming.some(item => item.id === boundary);
        cursor = page.nextCursor || null;
        if (cursor && visited.has(cursor)) throw Error('Message page repeated its cursor.');
        if (cursor) visited.add(cursor);
      } while (boundary && !overlap && cursor);
      if (token !== generation) return;
      if (boundary && overlap) {
        // Older may finish while refresh is paging. Merge against the current
        // list and keep its advanced cursor so that page remains reachable.
        const current = messages, currentCursor = nextCursor;
        const oldIds = new Set(incoming.map(item => item.id));
        messages = unique([...incoming, ...current.filter(item => !oldIds.has(item.id))]);
        // If Older advanced during refresh, keep the cursor for that same tail.
        nextCursor = currentCursor;
      } else {
        // No overlap means the source changed or was cleared. Replace the old
        // range and cursor instead of preserving records that cannot be read.
        messages = incoming;
        nextCursor = cursor;
      }
      error = null;
      emit({ prepend: !!boundary && overlap });
    } catch (caught) {
      if (token !== generation) return;
      error = caught.message;
      emit({});
    }
  }

  async function older() {
    if (!rootId || !agentId || !nextCursor || olderLoading) return;
    olderLoading = true;
    const token = generation, root = rootId, agent = agentId, cursor = nextCursor;
    try {
      const page = await fetchPage(root, agent, cursor);
      if (token !== generation || !sameSelection(root, agent)) return;
      const seen = new Set(messages.map(item => item.id));
      messages = [...messages, ...(page.messages || []).filter(item => item?.id && !seen.has(item.id) && seen.add(item.id))];
      nextCursor = page.nextCursor || null;
      error = null;
      emit({ prepend: false });
    } catch (caught) {
      if (token !== generation) return;
      error = caught.message;
      emit({});
    } finally { olderLoading = false; }
  }

  function select(root, agent) {
    if (sameSelection(root, agent)) return Promise.resolve();
    generation++;
    rootId = root; agentId = agent; messages = []; nextCursor = null; error = null;
    emit({ prepend: false });
    return refresh();
  }

  return { select, refresh, older, state: () => ({ rootId, agentId, messages: [...messages], nextCursor, error }) };
}
