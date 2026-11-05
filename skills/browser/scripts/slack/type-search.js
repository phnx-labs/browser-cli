// Type into the GLOBAL SEARCH box (not the message composer).
// Open search first: click the "Search" button (top bar) so the dialog exists.
// Edit ARG below. After running, the search dropdown shows results; prefer
// navigating to a result's id (find-ids.js) over clicking it (result refs drift).
(() => {
  const ARG = "SEARCH TERMS HERE"; // <-- edit me
  const q = [...document.querySelectorAll('[role="combobox"][aria-label="Query"]')]
    .find(e => e.closest('[role="dialog"], .c-search'));
  if (!q) return 'search not open — click the Search button first, then rerun';
  q.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  document.execCommand('insertText', false, ARG); // React ignores .value; execCommand works
  return 'typed into search: ' + ARG;
})()
