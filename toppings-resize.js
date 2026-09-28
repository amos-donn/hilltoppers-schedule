// Copy this file into your Topping and load it with a deferred script tag.
(() => {
  const params = new URLSearchParams(location.search);
  const host = params.get('host');
  const session = params.get('session');
  const content = document.querySelector('[data-topping-content]');
  if (!host || !session || !content || parent === window) return;
  let enabled = false;
  let frame = 0;
  let lastHeight = 0;
  function schedule() {
    if (!enabled || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      // Measure a natural-height wrapper, not document.scrollHeight: the latter
      // includes the iframe viewport and prevents the page from shrinking.
      const bounds = content.getBoundingClientRect();
      const body = getComputedStyle(document.body);
      const height = Math.ceil(bounds.bottom + window.scrollY + (parseFloat(body.paddingBottom) || 0) + (parseFloat(body.marginBottom) || 0));
      if (height <= 0 || height === lastHeight) return;
      lastHeight = height;
      parent.postMessage({ channel: 'hilltoppers-topping-v1', session, type: 'resize', height }, host);
    });
  }
  const observer = new ResizeObserver(schedule);
  observer.observe(content);
  window.addEventListener('message', event => {
    if (event.source !== parent || event.origin !== host) return;
    const data = event.data;
    if (data?.channel !== 'hilltoppers-topping-v1' || data.session !== session || data.type !== 'context') return;
    const next = data.heightMode === 'content';
    // The host drops its frame back to the fixed layout whenever the mode
    // changes and waits for a fresh report. Re-entering content mode therefore
    // has to report even when the height is unchanged, or choosing "Fit
    // content" would leave the frame at the fixed height until the content
    // happened to change. Steady-state content mode keeps suppressing
    // duplicates, so the repeating context message does not spam reports.
    if (next && !enabled) lastHeight = 0;
    enabled = next;
    schedule();
  });
  window.addEventListener('resize', schedule);
})();
