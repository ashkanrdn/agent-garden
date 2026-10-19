export function normalizeTimeRange(start, end, maxDay) {
  const clamp = value => Math.max(0, Math.min(maxDay, Math.round(Number(value) || 0)));
  const a = clamp(start), b = clamp(end);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

export function sessionInTimeRange(session, range) {
  return !range || (session.birth >= range.start && session.birth <= range.end);
}

export function createTimelineBrush({ element, clearButton, summary, maxDay, dateText, onChange }) {
  const selection = element.querySelector('.brush-selection');
  const handles = [...element.querySelectorAll('.brush-handle')];
  let range = null, gesture = null, frame = null;
  const position = day => {
    const width = element.getBoundingClientRect().width;
    return maxDay() ? 8 + day / maxDay() * Math.max(0, width - 16) : width / 2;
  };
  const pointerDay = event => {
    const rect = element.getBoundingClientRect();
    return Math.max(0, Math.min(maxDay(), Math.round((event.clientX - rect.left - 8) / Math.max(1, rect.width - 16) * maxDay())));
  };
  function render() {
    selection.hidden = clearButton.hidden = !range;
    summary.textContent = range ? `${dateText(range.start)} – ${dateText(range.end)} · created in range` : 'Drag above to select dates';
    if (range) {
      selection.style.left = position(range.start) + 'px';
      selection.style.width = Math.max(2, position(range.end) - position(range.start)) + 'px';
    }
    for (const handle of handles) {
      const bound = handle.dataset.bound;
      // Keep both ends available to the keyboard before the first pointer gesture.
      handle.hidden = false;
      const value = range?.[bound] ?? (bound === 'start' ? 0 : maxDay());
      handle.style.left = position(value) + 'px';
      handle.setAttribute('aria-valuemin', String(bound === 'end' ? range?.start ?? 0 : 0));
      handle.setAttribute('aria-valuemax', String(bound === 'start' ? range?.end ?? maxDay() : maxDay()));
      handle.setAttribute('aria-valuenow', String(value));
      handle.setAttribute('aria-valuetext', dateText(value));
    }
  }
  function flush() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    onChange(range && { ...range });
  }
  function set(next, notify = true) {
    const normalized = next ? normalizeTimeRange(next.start, next.end, maxDay()) : null;
    const changed = range?.start !== normalized?.start || range?.end !== normalized?.end;
    range = normalized;
    render();
    if (notify && changed && frame === null) frame = requestAnimationFrame(flush);
  }
  element.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    const bound = event.target.closest('.brush-handle')?.dataset.bound;
    const initial = range || { start: 0, end: maxDay() };
    gesture = { id: event.pointerId, anchor: bound ? initial[bound === 'start' ? 'end' : 'start'] : pointerDay(event), previous: range && { ...range } };
    element.setPointerCapture(event.pointerId);
    set(normalizeTimeRange(gesture.anchor, pointerDay(event), maxDay()));
  });
  element.addEventListener('pointermove', event => {
    if (gesture?.id === event.pointerId) set(normalizeTimeRange(gesture.anchor, pointerDay(event), maxDay()));
  });
  const finish = event => {
    if (gesture?.id !== event.pointerId) return;
    const previous = gesture.previous;
    gesture = null;
    if (event.type === 'pointercancel') set(previous, false);
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    flush();
  };
  element.addEventListener('pointerup', finish);
  element.addEventListener('pointercancel', finish);
  element.addEventListener('lostpointercapture', finish);
  for (const handle of handles) handle.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); set(null); return; }
    const step = event.shiftKey ? 7 : 1;
    const delta = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[event.key];
    if (delta === undefined && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = { ...(range || { start: 0, end: maxDay() }) }, bound = handle.dataset.bound;
    const low = bound === 'end' ? next.start : 0, high = bound === 'start' ? next.end : maxDay();
    next[bound] = event.key === 'Home' ? low : event.key === 'End' ? high : Math.max(low, Math.min(high, next[bound] + delta));
    set(next);
  });
  clearButton.addEventListener('click', () => set(null));
  return { render, clear() { gesture = null; if (frame !== null) cancelAnimationFrame(frame); frame = null; set(null, false); } };
}
