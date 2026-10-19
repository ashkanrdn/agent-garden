/** Current local evidence, independent of the historical playback clock. */
export function createGardenLiveState() {
  let revision = -1;
  let observedAt = null;
  const projects = new Map(), sessions = new Map(), agents = new Map();

  function apply(message, { snapshot = false } = {}) {
    if (message?.schemaVersion !== 1 || !Number.isSafeInteger(message.revision)) return null;
    if (!snapshot && message.revision <= revision) return null;
    const previousSessions = new Set(sessions.keys());
    if (snapshot) { projects.clear(); sessions.clear(); agents.clear(); }
    for (const project of message.projects || []) if (project?.id) projects.set(project.id, project);
    for (const session of message.sessions || []) if (session?.id) sessions.set(session.id, session);
    for (const agent of message.agents || []) if (agent?.id) agents.set(agent.id, agent);
    for (const id of message.removedSessionIds || []) sessions.delete(id);
    for (const id of message.removedAgentIds || []) agents.delete(id);
    revision = message.revision;
    observedAt = message.observedAt || observedAt;
    return {
      revision,
      snapshot,
      projectIds: (message.projects || []).map(item => item.id),
      sessionIds: snapshot ? [...new Set([...previousSessions, ...sessions.keys()])] : [
        ...(message.sessions || []).map(item => item.id), ...(message.removedSessionIds || []),
      ],
      agentIds: snapshot ? [...agents.keys()] : [
        ...(message.agents || []).map(item => item.id), ...(message.removedAgentIds || []),
      ],
    };
  }
  function agentsFor(rootSessionId) {
    return [...agents.values()].filter(agent => agent.isSubagent && !agent.isGuardian && agent.rootSessionId === rootSessionId);
  }
  function agentState(agentId, now = Date.now()) {
    const agent = agents.get(agentId);
    if (!agent) return null;
    const pending = agent.state === 'working' || agent.state === 'waiting';
    const last = Date.parse(agent.lastEventAt);
    const quiet = pending && Number.isFinite(last) && now - last >= 60000;
    const started = Date.parse(agent.turnStartedAt), ended = Date.parse(agent.turnEndedAt);
    const end = pending ? now : ended;
    const elapsedMs = Number.isFinite(started) && Number.isFinite(end) ? Math.max(0, end - started) : null;
    return { ...agent, quiet, elapsedMs };
  }
  return {
    apply, agentsFor, agentState,
    project: id => projects.get(id), session: id => sessions.get(id), agent: id => agents.get(id),
    snapshot: () => ({ revision, observedAt, projects: [...projects.values()], sessions: [...sessions.values()], agents: [...agents.values()] }),
  };
}
