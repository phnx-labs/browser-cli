// Returns the team id and every sidebar channel/DM/group id with its label.
// Use the ids to navigate by URL: https://app.slack.com/client/<TEAM>/<ID>
// (Navigating by URL is the ONLY reliable way — virtualized sidebar rows are
// not clickable via refs and ignore synthetic clicks.)
(() => {
  const team = location.pathname.split('/')[2] || '';
  const rows = [...document.querySelectorAll('[role="treeitem"][id]')];
  const items = rows
    .filter(r => /^[CDG][A-Z0-9]{6,}$/.test(r.id))
    .map(r => ({
      id: r.id,
      kind: r.id[0] === 'C' ? 'channel' : (r.id[0] === 'D' ? 'dm' : 'group'),
      label: (r.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    }));
  return JSON.stringify({
    team,
    navigate: `https://app.slack.com/client/${team}/<ID>`,
    items,
  }, null, 1);
})()
