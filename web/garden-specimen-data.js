(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GardenSpecimenData = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const THRESHOLDS = Object.freeze({
    quickWorkScore: 2.5,
    orchestrationAgents: 2,
    conversationTurns: 6,
    conversationToolsPerTurn: 8,
    slowBurnDurationHours: 2,
    slowBurnToolsPerHour: 15
  });
  const FRUIT_CAP = 5;
  const SIZE_CLASS_COUNT = 5;

  function sumActivity(session, kind) {
    return (session?.activity || []).reduce((sum, event) => {
      if (event?.kind !== kind) return sum;
      const count = Number(event.count ?? 1);
      return sum + (Number.isFinite(count) ? Math.max(0, count) : 0);
    }, 0);
  }

  function distinctFileCount(files) {
    const paths = new Set();
    (files || []).forEach((file, index) => {
      if (!(file?.events || []).length) return;
      paths.add(file.path || file.absolutePath || `__file_${index}`);
    });
    return paths.size;
  }

  function createdFileCount(files) {
    return (files || []).reduce((sum, file) => sum + (file?.events || []).filter(event => event?.kind === 'add').length, 0);
  }

  function ownedCommitCount(session) {
    if (Number.isFinite(Number(session?.ownedCommits))) return Math.max(0, Number(session.ownedCommits));
    return (session?.commits || []).filter(commit => commit?.ownership === 'verified' || commit?.ownership === 'exact').length;
  }

  function workScore(session) {
    const tools = sumActivity(session, 'tool');
    const turns = sumActivity(session, 'turn');
    const files = distinctFileCount(session?.files);
    const agents = new Set([...(session?.agentIds || []), ...(session?.subagents || [])]).size;
    const commits = ownedCommitCount(session);
    return Math.log1p(tools + 2 * turns + 3 * files + 4 * agents + 5 * commits);
  }

  function durationHours(session) {
    const start = Date.parse(session?.createdAt);
    const end = Date.parse(session?.updatedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
    return Math.max(0, (end - start) / 3600000);
  }

  function sessionMetrics(session) {
    const tools = sumActivity(session, 'tool');
    const turns = sumActivity(session, 'turn');
    const agents = new Set([...(session?.agentIds || []), ...(session?.subagents || [])]).size;
    const duration = durationHours(session);
    return {
      workScore: workScore(session),
      tools,
      turns,
      agents,
      durationHours: duration,
      toolsPerHour: duration > 0 ? tools / duration : (tools ? Infinity : 0),
      distinctFiles: distinctFileCount(session?.files),
      filesCreated: createdFileCount(session?.files)
    };
  }

  function asMetrics(value) {
    return value && typeof value === 'object' && 'workScore' in value ? value : sessionMetrics(value);
  }

  function classifySpecies(value) {
    const metrics = asMetrics(value);
    if (metrics.workScore < THRESHOLDS.quickWorkScore) return 'quick';
    if (metrics.agents >= THRESHOLDS.orchestrationAgents) return 'orchestration';
    if (metrics.turns >= THRESHOLDS.conversationTurns &&
      metrics.tools < THRESHOLDS.conversationToolsPerTurn * metrics.turns) return 'conversation';
    if (metrics.durationHours > THRESHOLDS.slowBurnDurationHours &&
      metrics.toolsPerHour < THRESHOLDS.slowBurnToolsPerHour) return 'slow-burn';
    return 'build';
  }

  function scoreOf(session) {
    return Number.isFinite(session?.workScore) ? session.workScore : sessionMetrics(session).workScore;
  }

  function sizeClasses(sessions) {
    const ordered = (sessions || []).map((session, index) => ({ session, index, score: scoreOf(session) }))
      .sort((a, b) => a.score - b.score || String(a.session?.id ?? '').localeCompare(String(b.session?.id ?? '')) || a.index - b.index);
    const classes = {};
    ordered.forEach(({ session }, rank) => {
      if (session?.id != null) classes[session.id] = Math.min(SIZE_CLASS_COUNT - 1,
        Math.floor(rank * SIZE_CLASS_COUNT / Math.max(1, ordered.length)));
    });
    return classes;
  }

  function densityLevel(metricsValue, allMetrics) {
    const metrics = asMetrics(metricsValue);
    const id = metricsValue?.id;
    const ranked = (allMetrics || []).map((value, index) => ({
      metrics: asMetrics(value), id: value?.id == null ? '' : String(value.id), index
    }));
    let target = ranked.find(item => item.metrics === metrics || (id != null && item.id === String(id)));
    if (!target) {
      target = { metrics, id: id == null ? '' : String(id), index: ranked.length, target: true };
      ranked.push(target);
    }
    ranked.sort((a, b) => a.metrics.distinctFiles - b.metrics.distinctFiles ||
      a.id.localeCompare(b.id) || a.index - b.index);
    const rank = ranked.indexOf(target);
    return ['sparse', 'medium', 'dense'][Math.min(2, Math.floor(rank * 3 / Math.max(1, ranked.length)))];
  }

  function fruitCount(metricsValue) {
    const metrics = asMetrics(metricsValue);
    return Math.min(FRUIT_CAP, Math.max(0, Math.floor(Number(metrics.filesCreated) || 0)));
  }

  // Already measured records: rank each channel once for the entire cohort.
  // No raw-session folding or work-score recomputation occurs at this boundary.
  function encodeMetrics(records) {
    const cohort = Array.isArray(records) ? records : [];
    const classes = sizeClasses(cohort.map(record => ({ id: record.id, workScore: record.metrics.workScore })));
    const densities = new Map();
    cohort.slice().sort((a, b) => a.metrics.distinctFiles - b.metrics.distinctFiles ||
      String(a.id).localeCompare(String(b.id))).forEach((record, rank) => {
      densities.set(record.id, ['sparse', 'medium', 'dense'][Math.floor(rank * 3 / cohort.length)]);
    });
    return cohort.map(record => ({
      id: record.id,
      project: record.projectId || record.project || 'unknown',
      species: classifySpecies(record.metrics),
      sizeClass: classes[record.id],
      density: densities.get(record.id),
      fruit: fruitCount(record.metrics),
      subagents: [...(record.subagents || [])],
      metrics: record.metrics
    }));
  }

  function encodeSessions(sessions) {
    const records = Array.isArray(sessions) ? sessions : [];
    const primary = records.filter(session => !session?.isSubagent);
    const children = new Map(primary.map(session => [session.id, []]));
    for (const session of records) {
      if (!session?.isSubagent || !session.rootSessionId || !children.has(session.rootSessionId) || session.isGuardian) continue;
      children.get(session.rootSessionId).push(session);
    }
    const normalized = primary.map(session => {
      const descendants = children.get(session.id) || [];
      const subagents = [...new Set([...(session.agentIds || []), ...descendants.map(child => child.id)])];
      return {
        ...session,
        activity: [...(session.activity || []), ...descendants.flatMap(child => child.activity || [])],
        files: [...(session.files || []), ...descendants.flatMap(child => child.files || [])],
        commits: [...(session.commits || []), ...descendants.flatMap(child => child.commits || [])],
        agentIds: subagents,
        subagents
      };
    });
    return encodeMetrics(normalized.map(session => ({ ...session, metrics: sessionMetrics(session) })));
  }

  return Object.freeze({ THRESHOLDS, FRUIT_CAP, workScore, sessionMetrics, classifySpecies,
    sizeClasses, densityLevel, fruitCount, encodeMetrics, encodeSessions });
});
