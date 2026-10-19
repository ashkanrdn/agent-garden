// Use the same work score as tree growth, with stable ordering for equal scores.
export function largestSessionIds(sessions, score, count = 10) {
  return new Set([...sessions].sort((a, b) =>
    score(b) - score(a) || a.id.localeCompare(b.id)
  ).slice(0, count).map(session => session.id));
}

export function projectLabelCandidates(plots, sessions, largest, zoom, fitZoom) {
  const majorProjects = new Set(sessions.filter(session => largest.has(session.id))
    .map(session => session.projectId));
  const close = zoom >= fitZoom * 2;
  return plots.filter(plot => majorProjects.has(plot.id) || close)
    .map(plot => ({...plot, major: majorProjects.has(plot.id)}))
    .sort((a, b) => Number(b.major) - Number(a.major) || a.id.localeCompare(b.id));
}
