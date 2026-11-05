// Type into the CURRENT channel/DM message composer (NOT search, NOT a thread).
// Edit ARG below. This does NOT send — after running, screenshot to verify the
// text AND that you are in the right conversation, then `browser press Enter`.
(() => {
  const ARG = "MESSAGE TEXT HERE"; // <-- edit me
  const ed = [...document.querySelectorAll('[data-qa="texty_input"], .ql-editor')]
    .filter(e => e.offsetParent !== null && !e.closest('[role="dialog"], .c-search'))
    .find(e => /^message /i.test(e.getAttribute('aria-label') || ''));
  if (!ed) return 'composer not found — are you inside a channel or DM?';
  ed.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  document.execCommand('insertText', false, ARG); // React ignores .value; execCommand works
  return 'composed (NOT sent) into "' + (ed.getAttribute('aria-label') || '') + '" — screenshot, then press Enter';
})()
