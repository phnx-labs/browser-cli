// Read replies from the OPEN thread flexpane (right-side panel).
// Open a thread first: click the "N replies" / reply bar under a message.
(() => {
  const pane = document.querySelector('[data-qa="threads_flexpane"], [data-qa="flexpane"], .p-flexpane, [role="complementary"]');
  if (!pane) return 'no thread open — click a message reply bar first';
  const msgs = [...pane.querySelectorAll('[data-qa="message_content"], .c-message_kit__blocks, .p-rich_text_section')]
    .map(m => (m.innerText || m.textContent || '').trim())
    .filter(t => t.length > 1);
  return JSON.stringify([...new Set(msgs)], null, 1);
})()
