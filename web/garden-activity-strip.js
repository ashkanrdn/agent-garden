export function buildDailyProjectActivity(sessions, { startTime, dayMs, maxDay }) {
  const length = Math.max(0, Math.floor(maxDay) + 1);
  const projectsByDay = Array.from({ length }, () => new Set());
  const sessionsByDay = Array.from({ length }, () => new Set());
  const roots = new Map((sessions || []).filter(session => !session?.isSubagent && session?.id).map(session => [session.id, session]));

  for (const [index, session] of (sessions || []).entries()) {
    const root = session?.isSubagent ? roots.get(session.rootSessionId) : session;
    const projectId = root?.projectId;
    if (!projectId) continue;
    const sessionId = session.id || `session-${index}`;
    for (const event of session.activity || []) {
      const at = Date.parse(event?.at);
      if (!Number.isFinite(at) || !Number.isFinite(startTime) || !(dayMs > 0)) continue;
      const day = Math.floor((at - startTime) / dayMs);
      if (day < 0 || day >= length) continue;
      projectsByDay[day].add(projectId);
      sessionsByDay[day].add(sessionId);
    }
  }

  return projectsByDay.map((projects, day) => ({
    projectCount: projects.size,
    sessionCount: sessionsByDay[day].size,
  }));
}

export function layoutActivityCells(count, stripHeight, { cellHeight = 3, gap = 1, topPadding = 2, bottomPadding = 1 } = {}) {
  const height = Math.max(0, Math.floor(Number(stripHeight) || 0));
  const cell = Math.max(1, Math.floor(cellHeight));
  const spacing = Math.max(0, Math.floor(gap));
  const available = Math.max(0, height - topPadding - bottomPadding);
  const capacity = Math.max(0, Math.floor((available + spacing) / (cell + spacing)));
  const total = Math.max(0, Math.floor(Number(count) || 0));
  const visible = Math.min(total, capacity);
  const bottom = height - bottomPadding;
  const rects = Array.from({ length: visible }, (_, index) => ({
    y: bottom - cell - index * (cell + spacing),
    height: cell,
  }));
  const overflow = total > capacity;
  return { rects, capacity, overflow, cap: overflow ? { y: 0, height: 1 } : null };
}
