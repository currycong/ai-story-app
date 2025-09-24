// script.js (full, with image-fail fallback -> jump to first story and skip TTS)
/* eslint-disable no-console */
document.addEventListener('DOMContentLoaded', () => {
  const gallery = document.getElementById('gallery');
  const loader = document.getElementById('loader');
  const modal = document.getElementById('story-modal');
  const storyPlayer = document.getElementById('story-player');
  const subtitleContainer = document.getElementById('subtitle-container');
  const storyLoader = document.getElementById('story-loader');
  const closeModalBtn = document.getElementById('close-modal');

  // ===== State =====
  let isLoading = false;
  let storiesData = [];                 // [{ id, prompt, story, imageUrl, element }]
  let currentStoryIndex = 0;

  // Audio / subtitle control
  let currentAudio = null;
  let currentAudioUrl = null;           // for URL.revokeObjectURL
  let subtitleTimeouts = [];
  let currentPlayToken = 0;             // bump each time we start a new story
  let speechAbortController = null;     // cancel pending TTS fetch when switching fast

  // Home feed control
  let lastBatchElements = [];
  const usedPrompts = new Set();

  // Navigation throttle (avoid rapid multi-trigger on wheel/gesture)
  let navLock = false;
  const NAV_THROTTLE_MS = 250;

  // ===== Initial load (allow cache) =====
  loadNewStories({ insert: 'append', forceRefresh: false });

  /**
   * Fetch a fresh batch of stories (target 4), render to gallery.
   * insert: 'append' | 'prepend'
   * forceRefresh: whether to call backend with ?refresh=true
   */
  async function loadNewStories({ insert = 'append', forceRefresh = false } = {}) {
    if (isLoading) return;
    isLoading = true;
    loader.classList.remove('hidden');

    try {
      const TARGET = 4;
      const newStories = [];
      const createdItems = [];

      let tries = 0;
      while (newStories.length < TARGET && tries < 3) {
        tries++;
        const url = (forceRefresh || tries > 1)
          ? '/api/get-story-ideas?refresh=true'
          : '/api/get-story-ideas';
        const resp = await fetch(url);
        const data = await resp.json();
        const candidates = Array.isArray(data.stories) ? data.stories : [];
        const fresh = candidates.filter(s => s && s.prompt && !usedPrompts.has(s.prompt));
        for (const s of fresh) {
          newStories.push(s);
          if (newStories.length === TARGET) break;
        }
      }

      if (newStories.length === 0) {
        const fb = await fetch('/api/get-story-ideas?refresh=true');
        const fbData = await fb.json();
        const fbFresh = (fbData.stories || []).filter(s => s && s.prompt && !usedPrompts.has(s.prompt));
        newStories.push(...fbFresh.slice(0, TARGET));
      }
      if (newStories.length === 0) throw new Error('No fresh stories available from backend.');

      // Build placeholders in DOM first
      const placeholders = newStories.map((storyIdea) => {
        const item = document.createElement('div');
        item.className = 'gallery-item';
        item.innerHTML = '<div class="spinner"></div>';
        if (insert === 'prepend') gallery.prepend(item); else gallery.appendChild(item);
        return { ...storyIdea, element: item, id: Date.now() + Math.random() };
      });

      // Generate images; if any image fails -> remove its DOM and DO NOT add it to storiesData
      await Promise.all(placeholders.map(async (s) => {
        try {
          const r = await fetch('/api/generate-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: s.prompt })
          });
          const imgData = await r.json();

          if (!imgData || !imgData.base64) {
            // image generation failed (e.g., 429 / insufficient balance)
            s.failed = true;
            if (s.element && s.element.parentElement) s.element.parentElement.removeChild(s.element);
            return;
          }

          const img = document.createElement('img');
          img.src = `data:image/png;base64,${imgData.base64}`;
          s.imageUrl = img.src;

          s.element.innerHTML = '';
          s.element.appendChild(img);

          if (imgData.cached) {
            const tag = document.createElement('div');
            tag.className = 'cache-indicator';
            tag.textContent = '💾';
            tag.title = '从缓存加载';
            s.element.appendChild(tag);
          }

          s.element.dataset.id = s.id;
          s.element.addEventListener('click', () => openStory(s.id));
          createdItems.push(s.element);
        } catch (err) {
          // network/API error -> treat as failed image
          console.error('Image generation failed for prompt:', s.prompt, err);
          s.failed = true;
          if (s.element && s.element.parentElement) s.element.parentElement.removeChild(s.element);
        }
      }));

      // Keep only successful stories (with imageUrl)
      const successStories = placeholders.filter(s => !s.failed && s.imageUrl);

      // Record used prompts only for success ones
      successStories.forEach(s => usedPrompts.add(s.prompt));

      // Update global store
      if (insert === 'prepend') {
        storiesData = [...successStories, ...storiesData];
      } else {
        storiesData.push(...successStories);
      }
      lastBatchElements = createdItems;

    } catch (error) {
      console.error('Failed to load new stories:', error);
      loader.innerText = '加载失败，请刷新重试。';
    } finally {
      isLoading = false;
      loader.classList.add('hidden');
    }
  }

  // ===== Open fullscreen and play =====
  async function openStory(id) {
    const idx = storiesData.findIndex(s => s.id == id);
    if (idx === -1) return;
    currentStoryIndex = idx;
    modal.classList.remove('hidden');
    await playCurrentStory();
  }

  // ===== Core: play story audio + subtitles (with race protection) =====
  async function playCurrentStory() {
    // Validate playable story (must have imageUrl). If invalid, jump to the very first playable story.
    if (!storiesData.length || !storiesData[currentStoryIndex] || !storiesData[currentStoryIndex].imageUrl) {
      const firstPlayableIndex = storiesData.findIndex(x => x.imageUrl);
      if (firstPlayableIndex >= 0) {
        currentStoryIndex = firstPlayableIndex;
        // no recursion loop because we checked imageUrl above
      } else {
        // no playable story at all -> close modal
        closeStory();
        return;
      }
    }

    const s = storiesData[currentStoryIndex];
    if (!s || !s.imageUrl) {
      closeStory();
      return;
    }

    // 1) stop previous audio & timers immediately
    stopCurrentAudio();

    // 2) bump play token, cancel any in-flight TTS fetch
    const myToken = ++currentPlayToken;
    if (speechAbortController) {
      try { speechAbortController.abort(); } catch {}
    }
    speechAbortController = new AbortController();

    // 3) prepare background only (do NOT show subtitles yet)
    storyPlayer.style.backgroundImage = `url(${s.imageUrl})`;
    subtitleContainer.innerHTML = '';
    subtitleContainer.style.display = 'none';
    storyLoader.classList.remove('hidden');

    try {
      // Only request TTS after we confirmed there is a valid image (done above)
      const speechResponse = await fetch('/api/generate-speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: s.story }),
        signal: speechAbortController.signal
      });

      // If we switched stories while waiting, ignore this response
      if (myToken !== currentPlayToken) return;

      const speechData = await speechResponse.json();
      storyLoader.classList.add('hidden');
      storyPlayer.classList.add('animate-ken-burns', 'animate-handheld');


      // Now show subtitles since audio is ready
      subtitleContainer.style.display = 'block';

      // Again guard: if token changed during JSON parse/UI update, bail out
      if (myToken !== currentPlayToken) return;

      playAudioWithSubtitles(speechData.audioContent, speechData.timepoints, s.story, myToken);
    } catch (error) {
      if (error.name === 'AbortError') return; // switched story, safe to ignore
      console.error('Failed to generate speech:', error);
      // If TTS fails, don't show this story either -> jump to first playable
      const firstPlayableIndex = storiesData.findIndex(x => x.imageUrl);
      if (firstPlayableIndex >= 0) {
        currentStoryIndex = firstPlayableIndex;
        playCurrentStory();
      } else {
        closeStory();
      }
    }
  }

  // ===== Split lines (unchanged) =====
  function splitTextIntoLines(text) {
    const lines = [];
    const maxCharsPerLine = 12;
    const sentences = text.split(/([。！？\.\!\?])/);
    let currentLine = '';

    for (let i = 0; i < sentences.length; i++) {
      const part = sentences[i].trim();
      if (!part) continue;

      if (part.match(/[。！？\.\!\?]/)) {
        currentLine += part;
        if (currentLine) {
          lines.push({ text: currentLine });
          currentLine = '';
        }
      } else {
        const hasEnglish = /[a-zA-Z]/.test(part);

        if (hasEnglish) {
          const words = part.split(/\s+/);
          for (const word of words) {
            if (currentLine.length > 0 &&
                (currentLine.length + word.length + 1) > maxCharsPerLine) {
              lines.push({ text: currentLine });
              currentLine = word;
            } else {
              currentLine += (currentLine ? ' ' + word : word);
            }
          }
        } else {
          if (part.length > maxCharsPerLine) {
            const subParts = part.split(/([，,])/);
            for (const subPart of subParts) {
              if (!subPart) continue;

              if (currentLine.length + subPart.length > maxCharsPerLine && currentLine) {
                lines.push({ text: currentLine });
                currentLine = subPart;
              } else {
                currentLine += subPart;
              }
            }
          } else {
            if (currentLine.length + part.length > maxCharsPerLine && currentLine) {
              lines.push({ text: currentLine });
              currentLine = part;
            } else {
              currentLine += part;
            }
          }
        }
      }
    }
    if (currentLine) lines.push({ text: currentLine });
    return lines.length > 0 ? lines : [{ text }];
  }

  // ===== Play audio + progressive word highlight (token-aware) =====
  function playAudioWithSubtitles(audioBase64, timepoints, fullText, token) {
    // If a newer play started, ignore
    if (token !== currentPlayToken) return;

    // Revoke previous blob URL (if any)
    if (currentAudioUrl) {
      try { URL.revokeObjectURL(currentAudioUrl); } catch {}
      currentAudioUrl = null;
    }

    const audioBlob = new Blob([Uint8Array.from(atob(audioBase64), c => c.charCodeAt(0))], { type: 'audio/mpeg' });
    const audioUrl = URL.createObjectURL(audioBlob);
    currentAudioUrl = audioUrl;
    currentAudio = new Audio(audioUrl);

    subtitleContainer.innerHTML = '';

    const lines = splitTextIntoLines(fullText);

    // --- Token-aware: if a newer play starts, all timers will be ignored after stopCurrentAudio() ---
    const wordsData = [];
    let globalCharIndex = 0;

    lines.forEach((line, lineIndex) => {
      const lineText = line.text;
      let lineWords = [];
      let currentWord = '';
      let wordStartIndex = globalCharIndex;

      for (let i = 0; i < lineText.length; i++) {
        const char = lineText[i];
        const isChineseChar = /[\u4e00-\u9fa5]/.test(char);
        const isEnglishChar = /[a-zA-Z]/.test(char);
        const isPunctuation = /[。！？，、,\.\!\?]/.test(char);

        if (isChineseChar) {
          if (currentWord) {
            lineWords.push({ text: currentWord, startChar: wordStartIndex, endChar: globalCharIndex, lineIndex });
            currentWord = '';
          }
          lineWords.push({ text: char, startChar: globalCharIndex, endChar: globalCharIndex + 1, lineIndex });
          globalCharIndex++;
          wordStartIndex = globalCharIndex;
        } else if (isEnglishChar || /[0-9]/.test(char)) {
          if (!currentWord) wordStartIndex = globalCharIndex;
          currentWord += char;
          globalCharIndex++;
        } else if (char === ' ') {
          if (currentWord) {
            lineWords.push({ text: currentWord, startChar: wordStartIndex, endChar: globalCharIndex, lineIndex });
            currentWord = '';
          }
          globalCharIndex++;
          wordStartIndex = globalCharIndex;
        } else if (isPunctuation) {
          if (currentWord) {
            currentWord += char;
            globalCharIndex++;
            lineWords.push({ text: currentWord, startChar: wordStartIndex, endChar: globalCharIndex, lineIndex });
            currentWord = '';
            wordStartIndex = globalCharIndex;
          } else if (lineWords.length > 0) {
            lineWords[lineWords.length - 1].text += char;
            lineWords[lineWords.length - 1].endChar++;
            globalCharIndex++;
            wordStartIndex = globalCharIndex;
          } else {
            globalCharIndex++;
            wordStartIndex = globalCharIndex;
          }
        } else {
          globalCharIndex++;
        }
      }
      if (currentWord) {
        lineWords.push({ text: currentWord, startChar: wordStartIndex, endChar: globalCharIndex, lineIndex });
      }
      wordsData.push(...lineWords);
    });

    // --- DOM render for lines/words ---
    const maxVisibleLines = 2;
    const lineElements = [];
    const wordElements = [];
    let currentLineElement = null;
    let lastLineIndex = -1;

    wordsData.forEach((word, wordIndex) => {
      if (word.lineIndex !== lastLineIndex) {
        const lineDiv = document.createElement('div');
        lineDiv.className = 'subtitle-line';
        lineDiv.style.display = 'none';
        subtitleContainer.appendChild(lineDiv);
        lineElements[word.lineIndex] = lineDiv;
        currentLineElement = lineDiv;
        lastLineIndex = word.lineIndex;
      }
      const wordSpan = document.createElement('span');
      wordSpan.className = 'subtitle-word';
      wordSpan.innerHTML = word.text.replace(/ /g, '&nbsp;');
      wordSpan.dataset.wordIndex = wordIndex;
      wordSpan.dataset.lineIndex = word.lineIndex;

      if (wordIndex > 0 && wordsData[wordIndex - 1].lineIndex === word.lineIndex) {
        if (/[a-zA-Z]/.test(word.text) || /[a-zA-Z]/.test(wordsData[wordIndex - 1].text)) {
          const spaceSpan = document.createElement('span');
          spaceSpan.innerHTML = '&nbsp;';
          spaceSpan.className = 'word-space';
          currentLineElement.appendChild(spaceSpan);
        }
      }

      currentLineElement.appendChild(wordSpan);
      wordElements.push(wordSpan);
    });

    // Show subtitles once audio is ready to play
    subtitleContainer.style.display = 'block';

    currentAudio.play().catch(err => console.warn('Audio play blocked until user gesture:', err));

    let currentLineIdx = -1;

    function updateVisibleLines(targetLineIndex) {
      let startLine = Math.max(0, targetLineIndex - 1);
      if (targetLineIndex === 0) startLine = 0;
      if (startLine + maxVisibleLines > lineElements.length) {
        startLine = Math.max(0, lineElements.length - maxVisibleLines);
      }
      lineElements.forEach((el, idx) => {
        if (!el) return;
        if (idx >= startLine && idx < startLine + maxVisibleLines) {
          el.style.display = 'block';
          el.style.animation = 'fadeIn 0.3s ease';
        } else {
          el.style.display = 'none';
        }
      });
    }

    function updateWordHighlight(wordIdx) {
      // Ignore if a newer play started
      if (token !== currentPlayToken) return;

      wordElements.forEach(el => { if (el) el.classList.remove('highlight', 'current-word'); });
      if (wordElements[wordIdx]) {
        const currentWordEl = wordElements[wordIdx];
        currentWordEl.classList.add('highlight', 'current-word');

        const lineIdx = parseInt(currentWordEl.dataset.lineIndex, 10);
        if (lineIdx !== currentLineIdx) {
          lineElements.forEach(el => { if (el) el.classList.remove('active'); });
          if (lineElements[lineIdx]) lineElements[lineIdx].classList.add('active');
          currentLineIdx = lineIdx;
          updateVisibleLines(lineIdx);
        }
        for (let j = 0; j < wordIdx; j++) {
          if (wordElements[j]) wordElements[j].classList.add('sung');
        }
      }
    }

    // Schedule highlights (token-aware via stopCurrentAudio clearing timeouts)
    if (timepoints && timepoints.length > 0) {
      const timePerWord = currentAudio.duration
        ? (currentAudio.duration * 1000) / wordsData.length
        : 15000 / wordsData.length;
      wordsData.forEach((_, idx) => {
        const timeInMs = idx * timePerWord;
        const timeoutId = setTimeout(() => updateWordHighlight(idx), timeInMs);
        subtitleTimeouts.push(timeoutId);
      });
    } else {
      currentAudio.addEventListener('loadedmetadata', () => {
        if (token !== currentPlayToken) return; // in case we switched before metadata
        const duration = currentAudio.duration * 1000;
        const timePerWord = duration / wordsData.length;
        wordsData.forEach((_, idx) => {
          const timeoutId = setTimeout(() => updateWordHighlight(idx), idx * timePerWord);
          subtitleTimeouts.push(timeoutId);
        });
      });
    }

    currentAudio.onended = () => {
      if (token !== currentPlayToken) return;
      storyPlayer.classList.remove('animate-ken-burns');
      wordElements.forEach(el => { if (el) el.classList.remove('highlight', 'current-word', 'sung'); });
      lineElements.forEach(el => { if (el) el.classList.remove('active'); });
      subtitleContainer.style.display = 'none';
      subtitleTimeouts = [];
    };
  }

  // ===== Stop current audio and clear timers/listeners =====
  function stopCurrentAudio() {
    // Cancel TTS fetch if in-flight
    if (speechAbortController) {
      try { speechAbortController.abort(); } catch {}
      speechAbortController = null;
    }

    // Stop audio
    if (currentAudio) {
      try {
        currentAudio.pause();
        // Detach event handlers
        currentAudio.onended = null;
        currentAudio.src = '';
        currentAudio.load?.();
      } catch {}
      currentAudio = null;
    }

    // Revoke blob URL
    if (currentAudioUrl) {
      try { URL.revokeObjectURL(currentAudioUrl); } catch {}
      currentAudioUrl = null;
    }

    // Clear subtitle timers
    if (subtitleTimeouts.length > 0) {
      subtitleTimeouts.forEach(id => clearTimeout(id));
      subtitleTimeouts = [];
    }

    // Reset subtitle UI
    if (subtitleContainer) {
      const allWords = subtitleContainer.querySelectorAll('.subtitle-word');
      allWords.forEach(el => el.classList.remove('highlight', 'sung'));
      const allLines = subtitleContainer.querySelectorAll('.subtitle-line');
      allLines.forEach(el => el.classList.remove('active'));
      subtitleContainer.style.display = 'none';
    }
  }

  // ===== Close fullscreen =====
  function closeStory() {
    modal.classList.add('hidden');
    storyPlayer.classList.remove('animate-ken-burns');
    stopCurrentAudio();

    // Pin the latest batch to top on home
    if (lastBatchElements && lastBatchElements.length > 0) {
      for (let i = lastBatchElements.length - 1; i >= 0; i--) {
        const el = lastBatchElements[i];
        if (el && el.parentElement === gallery) gallery.prepend(el);
      }
    }
  }
  if (closeModalBtn) closeModalBtn.addEventListener('click', closeStory);

  // ===== Gestures & Wheel (capture inside modal) =====
  let touchStartY = 0;
  modal.addEventListener('touchstart', (e) => {
    touchStartY = e.changedTouches[0].screenY;
  }, { passive: true });

  modal.addEventListener('touchend', (e) => {
    const dy = touchStartY - e.changedTouches[0].screenY;
    if (Math.abs(dy) > 50) (dy > 0 ? nextStory() : previousStory());
  }, { passive: true });

  const wheelHandler = (e) => {
    if (modal.classList.contains('hidden')) return;
    e.preventDefault();
    e.stopPropagation();
    if (navLock) return;
    navLock = true;
    setTimeout(() => (navLock = false), NAV_THROTTLE_MS);

    if (e.deltaY > 0) nextStory();
    else previousStory();
  };
  modal.addEventListener('wheel', wheelHandler, { passive: false });
  window.addEventListener('wheel', wheelHandler, { passive: false });

  // ===== Preload next batch at every 4th item (append), then continue playing =====
  async function nextStory() {
    const atBatchTail = (currentStoryIndex % 4 === 3);
    if (atBatchTail && !isLoading) {
      await loadNewStories({ insert: 'append', forceRefresh: true });
    }

    // advance index; if we run past end (e.g., some new items failed image), wrap to first playable
    if (currentStoryIndex < storiesData.length - 1) {
      currentStoryIndex++;
    } else {
      const firstPlayableIndex = storiesData.findIndex(x => x.imageUrl);
      if (firstPlayableIndex >= 0) currentStoryIndex = firstPlayableIndex;
      else { closeStory(); return; }
    }
    await playCurrentStory();
  }

  function previousStory() {
    if (currentStoryIndex > 0) {
      currentStoryIndex--;
      playCurrentStory();
    }
  }

  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (modal.classList.contains('hidden')) return;
    switch (e.key) {
      case 'Escape': return closeStory();
      case 'ArrowDown':
      case 'ArrowRight':
        e.preventDefault(); return nextStory();
      case 'ArrowUp':
      case 'ArrowLeft':
        e.preventDefault(); return previousStory();
    }
  });
});
