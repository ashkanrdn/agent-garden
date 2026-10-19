(function (root, factory) {
  const data = typeof module === 'object' && module.exports
    ? require('./garden-specimen-data.js') : root.GardenSpecimenData;
  const api = factory(data);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GardenSpecimenEncoding = api;
})(typeof globalThis === 'object' ? globalThis : this, function (data) {
  'use strict';

  function born(record, day, cutoffMs) {
    if (Number.isFinite(record?.birth) && record.birth > day) return false;
    const created = Date.parse(record?.createdAt);
    // Derived roots have a canonical birth even if their source date is absent.
    return Number.isFinite(created) ? created <= cutoffMs : Number.isFinite(record?.birth);
  }

  function eventVisible(event, day, cutoffMs, createdMs) {
    if (!event) return false;
    if (Number.isFinite(event.day) && (event.day < 0 || event.day > day)) return false;
    if (event.at != null) {
      const time = Date.parse(event.at);
      // Activity is bucketed by hour; use the same birth-day boundary as workByDay.
      const birthDayMs = Math.floor(createdMs / 86400000) * 86400000;
      return Number.isFinite(time) && time <= cutoffMs && (!Number.isFinite(birthDayMs) || time >= birthDayMs);
    }
    return Number.isFinite(event.day);
  }

  /**
   * Encode the complete born cohort before applying visibility filters.
   * Call after evidence/day changes, not during drawing. The caller owns caching.
   * Browser: side-effect import garden-specimen-data.js before this module.
   */
  function encodeGardenSpecimens(derivedRoots, { day, cutoffMs } = {}) {
    if (!Number.isInteger(day) || day < 0 || !Number.isFinite(cutoffMs)) return new Map();
    const roots = (Array.isArray(derivedRoots) ? derivedRoots : []).filter(root =>
      root?.id != null && !root.isSubagent && !root.isGuardian && born(root, day, cutoffMs));
    const records = roots.map(root => {
      const createdMs = Date.parse(root.createdAt);
      const updatedMs = Date.parse(root.updatedAt);
      const durationHours = Number.isFinite(createdMs) && Number.isFinite(updatedMs)
        ? Math.max(0, (Math.min(updatedMs, cutoffMs) - createdMs) / 3600000) : 0;
      const members = new Map();
      for (const member of root.members || []) {
        if (member?.id == null || member.isGuardian || !born(member, day, cutoffMs)) continue;
        if (member.id !== root.id && (!member.isSubagent || member.rootSessionId !== root.id)) continue;
        if (!members.has(member.id)) members.set(member.id, member);
      }
      let tools = 0, turns = 0;
      for (const member of members.values()) {
        for (const event of member.activity || []) {
          if (!eventVisible(event, day, cutoffMs, createdMs)) continue;
          const count = Number(event.count ?? 1);
          if (!Number.isFinite(count) || count < 0) continue;
          if (event.kind === 'tool') tools += count;
          if (event.kind === 'turn') turns += count;
        }
      }
      const subagents = [...members.values()].filter(member => member.id !== root.id && member.isSubagent)
        .map(member => member.id).sort((a, b) => String(a).localeCompare(String(b)));
      let distinctFiles = 0, filesCreated = 0;
      // fileMap keys are canonical paths. Raw member.files would duplicate work.
      for (const file of root.fileMap?.values?.() || []) {
        let touched = false;
        for (const event of file.events || []) {
          if (!eventVisible(event, day, cutoffMs, createdMs)) continue;
          touched = true;
          if (event.kind === 'add') filesCreated++;
        }
        if (touched) distinctFiles++;
      }
      const canonicalScore = root.workByDay?.[day];
      return {
        id: root.id, project: root.projectId || root.project || 'unknown', subagents,
        metrics: {
          workScore: Number.isFinite(canonicalScore) ? canonicalScore : 0,
          tools, turns, agents: subagents.length, durationHours,
          toolsPerHour: durationHours > 0 ? tools / durationHours : (tools ? Infinity : 0),
          distinctFiles, filesCreated
        }
      };
    });
    const encoded = data.encodeMetrics(records).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return new Map(encoded.map(record => [record.id, {
      ...record,
      // Only visible channels participate: metadata and animation retain pixels.
      visualKey: `${record.species}:${record.sizeClass}:${record.density}:${record.fruit}`
    }]));
  }

  return Object.freeze({ encodeGardenSpecimens });
});
