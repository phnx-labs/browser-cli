// Read a voice-note (audio clip) transcript. Run TWICE:
//   1st call: clicks "Generate transcript" (if not yet generated). Wait ~6s.
//   2nd call: expands "View transcript" and returns the full timestamped text.
// Make sure the audio clip is in view first (scroll to it).
(() => {
  const gen = document.querySelector('[aria-label="Generate transcript for this audio"]');
  if (gen) { gen.scrollIntoView({ block: 'center' }); gen.click(); return 'clicked Generate transcript — wait ~6s and run again to read'; }
  const view = [...document.querySelectorAll('a,button,[role="button"]')]
    .find(e => /view transcript/i.test(e.textContent || ''));
  if (view) view.click();
  const box = [...document.querySelectorAll('div,section,aside')]
    .filter(d => /Transcript \(auto-generated\)/i.test(d.textContent || '') && /\d:\d\d/.test(d.textContent || ''))
    .sort((a, b) => a.textContent.length - b.textContent.length)[0];
  return box ? (box.innerText || box.textContent || '').trim().slice(0, 2500) : 'transcript not ready — wait a moment and rerun';
})()
