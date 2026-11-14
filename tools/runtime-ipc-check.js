(async () => {
  const api = window.dsh?.runtime;
  if (!api) return { ok: false, error: 'preload 未暴露 runtime' };
  const health = await api.system.health();
  const events = await api.events.read({ afterSeq: 0, limit: 5 });
  return {
    ok: health.ok === true && events.ok === true,
    apiVersion: api.apiVersion,
    health: health.ok ? health.data : health.error,
    events: events.ok ? { count: events.data.events.length, nextSeq: events.data.nextSeq } : events.error,
  };
})();
