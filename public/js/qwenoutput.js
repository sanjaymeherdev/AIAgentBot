async function getQwenLastOutput() {
  const candidates = [...document.querySelectorAll('div.qwen-markdown, [data-role="assistant"], [class*=\"assistant\"], [class*=\"message\"]')].reverse();
  const filtered = candidates
    .map(el => ({ el, text: (el.innerText || el.textContent || '').trim() }))
    .find(item => {
      if (!item.text || item.text.length < 50) return false;
      return !/how can i help|happy to help|i'm happy|i’d be happy|of course|sure/i.test(item.text.toLowerCase());
    });
  return filtered ? filtered.text : '';
}

async function waitForQwenResponse(options = {}) {
  const timeoutMs = Number.isFinite(options.timeout) ? Number(options.timeout) : 0;
  const intervalMs = Number(options.interval || 500);
  const stableThreshold = Number(options.stableThreshold || 3);

  const stopSelectors = [
    '[class*=\"stop-btn\"]',
    '[aria-label=\"Stop\"]',
    'button[class*=\"stop\"]',
    '.chat-input-stop'
  ];
  const typingSelectors = [
    '[class*=\"typing\"]',
    '[class*=\"loading\"]',
    '[data-streaming=\"true\"]',
    '.markdown-streaming',
    '[aria-busy=\"true\"]'
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

  while (true) {
    const stopButtonExists = exists(stopSelectors);
    const typingExists = exists(typingSelectors);
    const currentResponse = await getQwenLastOutput();
    const currentLength = currentResponse.length;
    const isGrowing = currentLength > state.lastResponseLength;

    if (stopButtonExists !== state.stopButton) {
      state.stopButton = stopButtonExists;
      console.log(`🛑 Stop button: ${stopButtonExists ? 'VISIBLE (generating)' : 'HIDDEN (complete)'}`);
    }

    if (typingExists !== state.typingIndicator) {
      state.typingIndicator = typingExists;
      console.log(`⌨️  Typing indicator: ${typingExists ? 'ACTIVE' : 'GONE'}`);
    }

    if (!stopButtonExists && !typingExists && currentLength > 0 && currentLength === state.lastResponseLength) {
      state.stableCount += 1;
    } else {
      state.stableCount = 0;
    }

    state.lastResponseLength = currentLength;
    lastResponseText = currentResponse;

    if (state.stableCount >= stableThreshold) {
      console.log('✅ RESPONSE COMPLETE! ✅');
      console.log(`📝 Final length: ${currentLength} characters`);
      console.log(`💬 FULL RESPONSE:\n${currentResponse}\n`);
      return { text: currentResponse, complete: true, timedOut: false };
    }

    if (timeoutMs > 0 && performance.now() - startTime >= timeoutMs) {
      console.log('⚠️ Qwen monitor timed out');
      return { text: lastResponseText, complete: false, timedOut: true };
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
