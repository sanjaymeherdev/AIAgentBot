async function waitForDeepSeekResponse(options = {}) {
  const timeoutMs = Number(options.timeout || 60000);
  const intervalMs = Number(options.interval || 500);
  const stableThreshold = Number(options.stableThreshold || 3);

  const stopSelectors = [
    '[aria-label="stop"]',
    '[aria-label="stop generating"]',
    'button.stop',
    '[class*="stop-generating"]'
  ];
  const typingSelectors = [
    '.typing',
    '.loading',
    '[class*="thinking"]',
    '[class*="generating"]',
    '.dots-animation'
  ];
  const messageSelectors = [
    '[class*="message"]',
    '[class*="assistant"]',
    '[data-message-role="assistant"]'
  ];

  const state = {
    stopButton: false,
    typingIndicator: false,
    lastResponseLength: 0,
    stableCount: 0
  };

  const startTime = performance.now();
  let lastResponseText = '';

  function exists(selectors) {
    return selectors.some(sel => !!document.querySelector(sel));
  }

  function getLastMessageText() {
    const nodes = messageSelectors.flatMap(sel => Array.from(document.querySelectorAll(sel)));
    if (!nodes.length) return '';
    const node = nodes[nodes.length - 1];
    return (node.innerText || node.textContent || '').trim();
  }

  while (performance.now() - startTime < timeoutMs) {
    const stopButtonExists = exists(stopSelectors);
    const typingExists = exists(typingSelectors);
    const currentResponse = getLastMessageText();
    const currentLength = currentResponse.length;
    const isGrowing = currentLength > state.lastResponseLength;

    if (!stopButtonExists && !typingExists && currentLength > 0 && currentLength === state.lastResponseLength) {
      state.stableCount += 1;
    } else {
      state.stableCount = 0;
    }

    state.stopButton = stopButtonExists;
    state.typingIndicator = typingExists;
    state.lastResponseLength = currentLength;
    lastResponseText = currentResponse;

    if (state.stableCount >= stableThreshold) {
      return { text: lastResponseText, complete: true, timedOut: false };
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  return { text: lastResponseText, complete: false, timedOut: true };
}
