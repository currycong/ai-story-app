/* eslint-disable no-console */
document.addEventListener('DOMContentLoaded', () => {
  // ---- DOM refs (全部容错) ----
  const gallery = document.getElementById('gallery');
  const loader = document.getElementById('loader');
  const modal = document.getElementById('story-modal');
  const storyPlayer = document.getElementById('story-player');
  const subtitleContainer = document.getElementById('subtitle-container');
  const storyLoader = document.getElementById('story-loader');
  const closeModalBtn = document.getElementById('close-modal');

  // 任意一个关键节点缺失就直接退出，避免报错卡首页
  if (!gallery || !storyPlayer) {
    console.error('Required DOM nodes missing. Aborting init.');
    return;
  }

  // ---- State ----
  let isLoading = false;
  let storiesData = [];                 // [{ id, prompt, story, imageUrl, element }]
  let currentStoryIndex = 0;

  // 音频/字幕
  let currentAudio = null;
  let currentAudioUrl = null;           // for URL.revokeObjectURL
  let subtitleTimeouts = [];
  let currentPlayToken = 0;             // bump each time we start a new story
  let speechAbortController = null;     // cancel pending TTS fetch when switching fast

  // 音频解锁（无覆盖层方案）
  let audioUnlocked = false;
  function tryUnlockAudio() {
    if (audioUnlocked) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        if (!window.__appAC__) window.__appAC__ = new AC();
        if (window.__appAC__.state === 'suspended') {
          window.__appAC__.resume();
        }
      }
    } catch (_) {}
    // 播一个极短静音以触发激活（不依赖任何DOM）
    try {
      const a = new Audio();
      a.muted = true;
      a.playsInline = true;
      a.src =
        'data:audio/mp3;base64,//uQZAAAAAAAAAAAAAAAAAAAA'; // 1ms 静音片段足够触发
      a.play().catch(() => {});
    } catch (_) {}
    audioUnlocked = true;
  }

  // 任何用户手势都尝试解锁（不弹UI）
  document.addEventListener('touchstart', tryUnlockAudio, { passive: true });
  document.addEventListener('click', tryUnlockAudio, { passive: true });

  // 首页手势也解锁，保证首个进入全屏就有声
  gallery.addEventListener?.('touchstart', tryUnlockAudio, { passive: true });

  // Home feed control
  let lastBatchElements = [];
  const usedPrompts = new Set();

  // 导航节流
  let navLock = false;
  const NAV_THROTTLE_MS = 250;

  // ---- 初次加载 ----
  loadNewStories({ insert: 'append', forceRefresh: false });

  // 统一显示/隐藏加载
  function setLoading(v) {
    isLoading = v;
    if (!loader) return;
    loader.classList.toggle('hidden', !v);
  }

  /**
   * 拉取一批新故事并渲染，保证满4张（失败/去重会继续补齐）
   */
  async function loadNewStories({ insert = 'append', forceRefresh = false } = {}) {
    if (isLoading) return;
    setLoading(true);

    const TARGET = 4;
    const createdItems = [];
    const batch = [];
    const maxRounds = 5;

    const renderStories = async (storyIdeas) => {
      const placeholders = storyIdeas.map((idea) => {
        const item = document.createElement('div');
        item.className = 'gallery-item';
        item.innerHTML = '<div class="spinner"></div>';
        if (insert === 'prepend') gallery.prepend(item); else gallery.appendChild(item);
        return { ...idea, element: item, id: Date.now() + Math.random() };
      });

      await Promise.all(placeholders.map(async (s) => {
        try {
          const r = await fetch('/api/generate-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: s.prompt })
          });
          const imgData = await r.json();
          if (!imgData || !imgData.base64) throw new Error('image-failed');

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
        } catch (e) {
          // 失败：移除占位，不计入 batch
          if (s.element && s.element.parentElement) s.element.parentElement.removeChild(s.element);
          s.failed = true;
        }
      }));

      return placeholders.filter(s => !s.failed && s.imageUrl);
    };

    try {
      let round = 0;
      while (batch.length < TARGET && round < maxRounds) {
        round++;
        const url = (forceRefresh || round > 1)
          ? '/api/get-story-ideas?refresh=true&lang=en'
          : '/api/get-story-ideas?lang=en';

        const resp = await fetch(url);
        const data = await resp.json();
        const candidates = Array.isArray(data.stories) ? data.stories : [];

        const freshIdeas = candidates.filter(s => s && s.prompt && !usedPrompts.has(s.prompt));
        const success = await renderStories(freshIdeas);

        success.forEach(s => {
          if (batch.length < TARGET) {
            batch.push(s);
            usedPrompts.add(s.prompt);
          } else {
            if (s.element && s.element.parentElement) s.element.parentElement.removeChild(s.element);
          }
        });
      }

      if (batch.length === 0) throw new Error('No playable stories.');

      if (insert === 'prepend') {
        storiesData = [...batch, ...storiesData];
      } else {
        storiesData.push(...batch);
      }

      lastBatchElements = createdItems;
    } catch (error) {
      console.error('Failed to load stories:', error);
      if (loader) loader.innerText = '加载失败，请刷新重试。';
    } finally {
      setLoading(false);
    }
  }

  // ---- 打开全屏并播放 ----
  async function openStory(id) {
    const idx = storiesData.findIndex(s => s.id == id);
    if (idx === -1) return;
    currentStoryIndex = idx;
    modal?.classList.remove('hidden');
    tryUnlockAudio(); // 确保进入全屏即解锁
    await playCurrentStory();
  }

  // ---- 播放当前故事（含并发保护）----
  async function playCurrentStory() {
    const playableIndex = findFirstPlayableIndexFrom(currentStoryIndex);
    if (playableIndex === -1) {
      closeStory();
      return;
    }
    currentStoryIndex = playableIndex;

    const s = storiesData[currentStoryIndex];
    stopCurrentAudio();

    const myToken = ++currentPlayToken;
    if (speechAbortController) { try { speechAbortController.abort(); } catch {} }
    speechAbortController = new AbortController();

    // 背景图
    if (storyPlayer) {
      storyPlayer.style.backgroundImage = `url(${s.imageUrl})`;
      storyPlayer.classList.add('animate-ken-burns');
    }
    if (subtitleContainer) {
      subtitleContainer.innerHTML = '';
      subtitleContainer.style.display = 'none';
    }
    storyLoader?.classList.remove('hidden');

    try {
      const speechResponse = await fetch('/api/generate-speech?lang=en', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: s.story }),
        signal: speechAbortController.signal
      });

      if (myToken !== currentPlayToken) return;

      const speechData = await speechResponse.json();
      storyLoader?.classList.add('hidden');
      if (storyPlayer) storyPlayer.classList.add('animate-ken-burns');
      if (subtitleContainer) subtitleContainer.style.display = 'block';

      if (myToken !== currentPlayToken) return;

      playAudioWithSubtitles(speechData.audioContent, speechData.timepoints, s.story, myToken);
    } catch (error) {
      if (error.name === 'AbortError') return;
      console.error('Failed to generate speech:', error);
      // TTS失败 → 跳到第一条可播
      const firstIdx = findFirstPlayableIndexFrom(0);
      if (firstIdx >= 0) {
        currentStoryIndex = firstIdx;
        playCurrentStory();
      } else {
        closeStory();
      }
    }
  }

  function findFirstPlayableIndexFrom(start) {
    if (!storiesData.length) return -1;
    for (let i = start; i < storiesData.length; i++) {
      if (storiesData[i] && storiesData[i].imageUrl) return i;
    }
    for (let i = 0; i < start; i++) {
      if (storiesData[i] && storiesData[i].imageUrl) return i;
    }
    return -1;
  }

  // ---- 文本分行（原逻辑保留）----
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

  // ---- 播放音频 + 字幕 ----
  function playAudioWithSubtitles(audioBase64, timepoints, fullText, token) {
    if (token !== currentPlayToken) return;

    if (currentAudioUrl) {
      try { URL.revokeObjectURL(currentAudioUrl); } catch {}
      currentAudioUrl = null;
    }

    const audioBlob = new Blob([Uint8Array.from(atob(audioBase64), c => c.charCodeAt(0))], { type: 'audio/mpeg' });
    const audioUrl = URL.createObjectURL(audioBlob);
    currentAudioUrl = audioUrl;
    currentAudio = new Audio(audioUrl);
    currentAudio.playsInline = true;
    currentAudio.autoplay = true;
    currentAudio.muted = false;

    // iOS/安卓：没有覆盖层，但我们尽可能自动解锁（如果失败，只是静默，用户再滑一次通常就能有声）
    currentAudio.play().catch((err) => {
      console.warn('Autoplay blocked, will rely on user gesture:', err?.message || err);
    });

    if (!subtitleContainer) return;
    subtitleContainer.innerHTML = '';
    const lines = splitTextIntoLines(fullText);

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

    subtitleContainer.style.display = 'block';
    let currentLineIdx = -1;

    function updateVisibleLines(targetLineIndex) {
      let startLine = Math.max(0, targetLineIndex - 1);
      if (targetLineIndex === 0) startLine = 0;
      if (startLine + maxVisibleLines > lineElements.length) {
        startLine = Math.max(0, lineElements.length - maxVisibleLines);
      }
      lineElements.forEach((el, idx) => {
        if (!el) return;
        el.style.display = (idx >= startLine && idx < startLine + maxVisibleLines) ? 'block' : 'none';
      });
    }

    function updateWordHighlight(wordIdx) {
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

    // 计时方案
    if (timepoints && timepoints.length > 0) {
      const timePerWord = currentAudio.duration
        ? (currentAudio.duration * 1000) / wordsData.length
        : 15000 / wordsData.length;
      wordsData.forEach((_, idx) => {
        const timeoutId = setTimeout(() => updateWordHighlight(idx), idx * timePerWord);
        subtitleTimeouts.push(timeoutId);
      });
    } else {
      currentAudio.addEventListener('loadedmetadata', () => {
        if (token !== currentPlayToken) return;
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
      storyPlayer?.classList.remove('animate-ken-burns');
      wordElements.forEach(el => { if (el) el.classList.remove('highlight', 'current-word', 'sung'); });
      lineElements.forEach(el => { if (el) el.classList.remove('active'); });
      if (subtitleContainer) subtitleContainer.style.display = 'none';
      subtitleTimeouts = [];
    };
  }

  // ---- 停止当前音频 ----
  function stopCurrentAudio() {
    if (speechAbortController) {
      try { speechAbortController.abort(); } catch {}
      speechAbortController = null;
    }
    if (currentAudio) {
      try {
        currentAudio.pause();
        currentAudio.onended = null;
        currentAudio.src = '';
        currentAudio.load?.();
      } catch {}
      currentAudio = null;
    }
    if (currentAudioUrl) {
      try { URL.revokeObjectURL(currentAudioUrl); } catch {}
      currentAudioUrl = null;
    }
    if (subtitleTimeouts.length > 0) {
      subtitleTimeouts.forEach(id => clearTimeout(id));
      subtitleTimeouts = [];
    }
    if (subtitleContainer) {
      const allWords = subtitleContainer.querySelectorAll('.subtitle-word');
      allWords.forEach(el => el.classList.remove('highlight', 'sung'));
      const allLines = subtitleContainer.querySelectorAll('.subtitle-line');
      allLines.forEach(el => el.classList.remove('active'));
      subtitleContainer.style.display = 'none';
    }
  }

  // ---- 关闭全屏 ----
  function closeStory() {
    modal?.classList.add('hidden');
    storyPlayer?.classList.remove('animate-ken-burns');
    stopCurrentAudio();

    // 回首页置顶最新批次
    if (lastBatchElements && lastBatchElements.length > 0) {
      for (let i = lastBatchElements.length - 1; i >= 0; i--) {
        const el = lastBatchElements[i];
        if (el && el.parentElement === gallery) gallery.prepend(el);
      }
    }
  }
  closeModalBtn?.addEventListener('click', closeStory);

  // ---- 全屏手势/滚轮 ----
  let touchStartY = 0;
  modal?.addEventListener('touchstart', (e) => {
    tryUnlockAudio(); // 任意触摸也解锁
    touchStartY = e.changedTouches[0].screenY;
  }, { passive: true });

  modal?.addEventListener('touchend', (e) => {
    const dy = touchStartY - e.changedTouches[0].screenY;
    if (Math.abs(dy) > 50) (dy > 0 ? nextStory() : previousStory());
  }, { passive: true });

  const wheelHandler = (e) => {
    if (modal?.classList.contains('hidden')) return;
    e.preventDefault();
    e.stopPropagation();
    if (navLock) return;
    navLock = true;
    setTimeout(() => (navLock = false), NAV_THROTTLE_MS);
    (e.deltaY > 0) ? nextStory() : previousStory();
  };
  modal?.addEventListener('wheel', wheelHandler, { passive: false });
  window.addEventListener('wheel', wheelHandler, { passive: false });

  // ---- 切换故事 & 预加载 ----
  async function nextStory() {
    const atBatchTail = (currentStoryIndex % 4 === 3);
    if (atBatchTail && !isLoading) {
      await loadNewStories({ insert: 'append', forceRefresh: true });
    }
    if (currentStoryIndex < storiesData.length - 1) {
      currentStoryIndex++;
      tryUnlockAudio();
      await playCurrentStory();
    }
  }
  function previousStory() {
    if (currentStoryIndex > 0) {
      currentStoryIndex--;
      tryUnlockAudio();
      playCurrentStory();
    }
  }

  // 键盘（桌面）
  document.addEventListener('keydown', (e) => {
    if (modal?.classList.contains('hidden')) return;
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
