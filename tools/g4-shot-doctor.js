/* G4 截图一：Doctor 体检 pane（真跑一轮体检后停留，供 --shot 目检样式） */
(async () => {
  openSettings('doctor');
  await runDoctorChecks(true);
  await new Promise((r) => setTimeout(r, 400));
  const counts = {};
  for (const c of doctorCache?.checks || []) counts[c.status] = (counts[c.status] || 0) + 1;
  return { pane: 'paneDoctor', counts, scores: $$('#doctorScores .doctor-item.is-score').length };
})();
