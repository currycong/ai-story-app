/* script.js — 全屏下滑下一条在 iOS 只有画面无声音的问题修复版
   关键点：
   1) 复用同一个全局 Audio 实例（已被用户手势“解锁”后，后续播放成功率更高）
   2) 若某次 play() 被策略拦截，登记一次性的“待手势补播”，用户下一次触摸/滑动自动补播
   3) 不使用任何“点一下开启声音”的覆盖层
*/

document.addEventListener('DOMContentLoaded', () => {
  // ===== DOM 引用（做容错，不阻塞首页） =====
  const gallery = document.getElementById('gallery');
  const loader = document.getElementById('loader');
  const modal = document.getElementById('story-modal');
  const storyPlayer = document.getElementById('story-player');
  const subtitleContainer = document.getElementById('subtitle-container');
  const storyLoader = document.getElementById('story-loader');
  const closeModalBtn = document.getElementById('close-modal');

  if (!gallery || !storyPlayer) {
    console.error('Missing required DOM nodes (#gallery or #story-player).');
    return;
  }

  // ===== 全局状态 =====
  let isLoading = false;
  let storiesData = [];            // [{ id, prompt, story, imageUrl, element }]
  let currentStoryIndex = 0;

  // 音频&字幕
  let currentAudioUrl = null;      // URL.createObjectURL 返回的 URL，用完及时 revoke
  let currentPlayToken = 0;        // 播放令牌，避免并发错乱
  let subtitleTimeouts = [];
  let speechAbortController = null;

  // ===== iOS 音频自动播放策略：单例 Audio + 手势解锁 + 手势补播 =====
  let audioUnlocked = false;
  let audioEl = null;
  let pendingGestureReplay = null; // 若 play() 被拒，下次手势触发时调用一次

  function ensureAudioEl() {
    if (audioEl) return audioEl;
    audioEl = new Audio();
    audioEl.playsInline = true;   // iOS 必需
    audioEl.autoplay = false;
    audioEl.preload = 'auto';
    audioEl.muted = false;
    return audioEl;
  }

  function tryUnlockAudio() {
    if (audioUnlocked) return;

    // 尝试用 WebAudio 解锁
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        if (!window.__appAC__) window.__appAC__ = new AC();
        if (window.__appAC__.state === 'suspended') window.__appAC__.resume();
      }
    } catch (_) {}

    // 播放极短静音触发“已互动”状态
    try {
      const a = new Audio();
      a.muted = true;
      a.playsInline = true;
      a.src = 'data:audio/mp3;base64,//uQZAAAAAAAAAAAAAAAAAAAA';
      a.play().catch(() => {});
    } catch (_) {}

    // 在手势上下文中创建全局 Audio 实例最稳
    ensureAudioEl();
    audioUnlocked = true;
  }

  // 任意用户手势都尝试解锁 & 触发待补播
  const gestureHandler = () => {
    tryUnlockAudio();
    if (pendingGestureReplay) {
      const fn = pendingGestureReplay;
      pendingGestureReplay = null;
      try { fn(); } catch (_) {}
    }
  };
  document.addEventListener('touchstart', gestureHandler, { passive: true });
  document.addEventListener('click', gestureHandler, { passive: true });

  // ===== 工具函数 =====
  function setLoading(v) {
    isLoading = v;
    if (loader) loader.classList.toggle('hidden', !v);
  }

  function stopCurrentAudio() {
    if (speechAbortController) {
      try { speechAbortController.abort(); } catch {}
      speechAbortController = null;
    }
    if (audioEl) {
      try {
        audioEl.pause();
        audioEl.onended = null;
        // 不要置空 src（iOS 会丢失权限），仅在换源时覆盖
      } catch {}
    }
    if (currentAudioUrl) {
      try { URL.revokeObjectURL(currentAudioUrl); } catch {}
      currentAudioUrl = null;
    }
    if (subtitleTimeouts.length) {
      subtitleTimeouts.forEach(id => clearTimeout(id));
      subtitleTimeouts = [];
    }
    if (subtitleContainer) {
      subtitleContainer.innerHTML = '';
      subtitleContainer.style.display = 'none';
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

  // ===== 首页加载：保证补齐 4 个卡片 =====
  const usedPrompts = new Set();
  let lastBatchElements = [];
  async function loadNewStories({ insert = 'append', forceRefresh = false } = {}) {
    if (isLoading) return;
    setLoading(true);

    const TARGET = 4;
    const created = [];
    const batch = [];
    const maxRounds = 5;

    const renderStories = async (ideas) => {
      const placeholders = ideas.map((idea) => {
        const el = document.createElement('div');
        el.className = 'gallery-item';
        el.innerHTML = '<div class="spinner"></div>';
        if (insert === 'prepend') gallery.prepend(el); else gallery.appendChild(el);
        return { ...idea, element: el, id: Date.now() + Math.random() };
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
          created.push(s.element);
        } catch (e) {
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
        const fresh = candidates.filter(s => s && s.prompt && !usedPrompts.has(s.prompt));

        const success = await renderStories(fresh);
        success.forEach(s => {
          if (batch.length < TARGET) {
            batch.push(s);
            usedPrompts.add(s.prompt);
          } else {
            if (s.element && s.element.parentElement) s.element.parentElement.removeChild(s.element);
          }
        });
      }

      if (batch.length === 0) throw new Error('No stories this round');

      if (insert === 'prepend') {
        storiesData = [...batch, ...storiesData];
      } else {
        storiesData.push(...batch);
      }
      lastBatchElements = created;
    } catch (err) {
      console.error('Failed to load stories:', err);
      if (loader) loader.textContent = '加载失败，请刷新重试';
    } finally {
      setLoading(false);
    }
  }

  // ===== 打开全屏并播放 =====
  async function openStory(id) {
    const idx = storiesData.findIndex(s => String(s.id) === String(id));
    if (idx === -1) return;
    currentStoryIndex = idx;
    modal?.classList.remove('hidden');
    tryUnlockAudio(); // 进入全屏即尝试解锁
    await playCurrentStory();
  }

  async function playCurrentStory() {
    const playable = findFirstPlayableIndexFrom(currentStoryIndex);
    if (playable === -1) {
      closeStory();
      return;
    }
    currentStoryIndex = playable;

    const s = storiesData[currentStoryIndex];
    stopCurrentAudio();
    const myToken = ++currentPlayToken;

    if (speechAbortController) { try { speechAbortController.abort(); } catch {} }
    speechAbortController = new AbortController();

    // 背景图 + 动效
    storyPlayer.style.backgroundImage = `url(${s.imageUrl})`;
    storyPlayer.classList.add('animate-ken-burns');

    if (subtitleContainer) {
      subtitleContainer.innerHTML = '';
      subtitleContainer.style.display = 'none';
    }
    storyLoader?.classList.remove('hidden');

    try {
      const r = await fetch('/api/generate-speech?lang=en', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: s.story }),
        signal: speechAbortController.signal
      });
      if (myToken !== currentPlayToken) return;

      const speechData = await r.json();
      storyLoader?.classList.add('hidden');
      subtitleContainer.style.display = 'block';

      if (myToken !== currentPlayToken) return;

      playAudioWithSubtitles(speechData.audioContent, speechData.timepoints || [], s.story, myToken);
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('TTS failed:', err);
      // 回退到第一条可播
      const firstIdx = findFirstPlayableIndexFrom(0);
      if (firstIdx >= 0) {
        currentStoryIndex = firstIdx;
        playCurrentStory();
      } else {
        closeStory();
      }
    }
  }

  function splitTextIntoLines(text) {
    const lines = [];
    const maxCharsPerLine = 12;
    const sentences = text.split(/([。！？\.\!\?])/);
    let currentLine = '';

    for (let i = 0; i < sentences.length; i++) {
      const part = sentences[i].trim();
      if (!part) continue;

      if (/[。！？\.\!\?]/.test(part)) {
        currentLine += part;
        if (currentLine) {
          lines.push({ text: currentLine });
          currentLine = '';
        }
      } else {
        const hasEnglish = /[a-zA-Z]/.test(part);
        if (hasEnglish) {
          const words = part.split(/\s+/);
          for (const w of words) {
            if (currentLine && (currentLine.length + w.length + 1) > maxCharsPerLine) {
              lines.push({ text: currentLine });
              currentLine = w;
            } else {
              currentLine += (currentLine ? ' ' + w : w);
            }
          }
        } else {
          if (part.length > maxCharsPerLine) {
            const subParts = part.split(/([，,])/);
            for (const sp of subParts) {
              if (!sp) continue;
              if (currentLine && (currentLine.length + sp.length > maxCharsPerLine)) {
                lines.push({ text: currentLine });
                currentLine = sp;
              } else {
                currentLine += sp;
              }
            }
          } else {
            if (currentLine && (currentLine.length + part.length > maxCharsPerLine)) {
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
    return lines.length ? lines : [{ text }];
  }

  function playAudioWithSubtitles(audioBase64, timepoints, fullText, token) {
    if (token !== currentPlayToken) return;

    // 生成 Blob URL，复用全局 audioEl
    if (currentAudioUrl) {
      try { URL.revokeObjectURL(currentAudioUrl); } catch {}
      currentAudioUrl = null;
    }
    const audioBlob = new Blob([Uint8Array.from(atob(audioBase64), c => c.charCodeAt(0))], { type: 'audio/mpeg' });
    const audioUrl = URL.createObjectURL(audioBlob);
    currentAudioUrl = audioUrl;

    const el = ensureAudioEl();
    try {
      el.pause();
      el.currentTime = 0;
      el.onended = null;
    } catch (_) {}

    el.src = audioUrl;

    // 核心：播放失败则记录“待手势补播”
    el.play().then(() => {
      pendingGestureReplay = null;
    }).catch(() => {
      pendingGestureReplay = () => {
        if (token !== currentPlayToken) return;
        el.play().catch(() => {});
      };
    });

    // ===== 字幕渲染 & 高亮 =====
    if (!subtitleContainer) return;
    subtitleContainer.innerHTML = '';
    const lines = splitTextIntoLines(fullText);

    const wordsData = [];
    let globalCharIndex = 0;
    const pushWord = (arr, text, startChar, endChar, lineIndex) => {
      arr.push({ text, startChar, endChar, lineIndex });
    };

    lines.forEach((line, lineIndex) => {
      const t = line.text;
      let curWord = '';
      let wordStart = globalCharIndex;

      for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        const isZh = /[\u4e00-\u9fa5]/.test(ch);
        const isEn = /[a-zA-Z]/.test(ch);
        const isPunc = /[。！？，、,\.\!\?]/.test(ch);

        if (isZh) {
          if (curWord) {
            pushWord(wordsData, curWord, wordStart, globalCharIndex, lineIndex);
            curWord = '';
          }
          pushWord(wordsData, ch, globalCharIndex, globalCharIndex + 1, lineIndex);
          globalCharIndex++;
          wordStart = globalCharIndex;
        } else if (isEn || /[0-9]/.test(ch)) {
          if (!curWord) wordStart = globalCharIndex;
          curWord += ch;
          globalCharIndex++;
        } else if (ch === ' ') {
          if (curWord) {
            pushWord(wordsData, curWord, wordStart, globalCharIndex, lineIndex);
            curWord = '';
          }
          globalCharIndex++;
          wordStart = globalCharIndex;
        } else if (isPunc) {
          if (curWord) {
            curWord += ch;
            globalCharIndex++;
            pushWord(wordsData, curWord, wordStart, globalCharIndex, lineIndex);
            curWord = '';
            wordStart = globalCharIndex;
          } else if (wordsData.length > 0 && wordsData[wordsData.length - 1].lineIndex === lineIndex) {
            wordsData[wordsData.length - 1].text += ch;
            wordsData[wordsData.length - 1].endChar++;
            globalCharIndex++;
            wordStart = globalCharIndex;
          } else {
            globalCharIndex++;
            wordStart = globalCharIndex;
          }
        } else {
          globalCharIndex++;
        }
      }
      if (curWord) {
        pushWord(wordsData, curWord, wordStart, globalCharIndex, lineIndex);
      }
    });

    // 行元素与词元素
    const maxVisibleLines = 2;
    const lineEls = [];
    const wordEls = [];
    let curLineIdx = -1;
    let curLineEl = null;
    let lastLineIdx = -1;

    wordsData.forEach((w, idx) => {
      if (w.lineIndex !== lastLineIdx) {
        const lineDiv = document.createElement('div');
        lineDiv.className = 'subtitle-line';
        lineDiv.style.display = 'none';
        subtitleContainer.appendChild(lineDiv);
        lineEls[w.lineIndex] = lineDiv;
        curLineEl = lineDiv;
        lastLineIdx = w.lineIndex;
      }
      const span = document.createElement('span');
      span.className = 'subtitle-word';
      span.innerHTML = w.text.replace(/ /g, '&nbsp;');
      span.dataset.wordIndex = idx;
      span.dataset.lineIndex = w.lineIndex;

      if (idx > 0 && wordsData[idx - 1].lineIndex === w.lineIndex) {
        if (/[a-zA-Z]/.test(w.text) || /[a-zA-Z]/.test(wordsData[idx - 1].text)) {
          const space = document.createElement('span');
          space.innerHTML = '&nbsp;';
          space.className = 'word-space';
          curLineEl.appendChild(space);
        }
      }
      curLineEl.appendChild(span);
      wordEls.push(span);
    });

    subtitleContainer.style.display = 'block';

    function updateVisibleLines(targetLine) {
      let start = Math.max(0, targetLine - 1);
      if (targetLine === 0) start = 0;
      if (start + maxVisibleLines > lineEls.length) {
        start = Math.max(0, lineEls.length - maxVisibleLines);
      }
      lineEls.forEach((el, i) => {
        if (!el) return;
        el.style.display = (i >= start && i < start + maxVisibleLines) ? 'block' : 'none';
      });
    }

    function updateWordHighlight(wordIdx) {
      if (token !== currentPlayToken) return;
      wordEls.forEach(el => el && el.classList.remove('highlight', 'current-word', 'sung'));
      if (wordEls[wordIdx]) {
        const cur = wordEls[wordIdx];
        cur.classList.add('highlight', 'current-word');
        const lineIdx = parseInt(cur.dataset.lineIndex, 10);
        if (lineIdx !== curLineIdx) {
          lineEls.forEach(el => el && el.classList.remove('active'));
          if (lineEls[lineIdx]) lineEls[lineIdx].classList.add('active');
          curLineIdx = lineIdx;
          updateVisibleLines(lineIdx);
        }
        for (let j = 0; j < wordIdx; j++) wordEls[j]?.classList.add('sung');
      }
    }

    // 计时：若后端给了 timepoints 可用它；否则按时长均分
    if (timepoints && timepoints.length > 0) {
      const tpw = (audioEl.duration ? audioEl.duration * 1000 : 15000) / wordsData.length;
      wordsData.forEach((_, i) => {
        const id = setTimeout(() => updateWordHighlight(i), i * tpw);
        subtitleTimeouts.push(id);
      });
    } else {
      audioEl.addEventListener('loadedmetadata', () => {
        if (token !== currentPlayToken) return;
        const dur = audioEl.duration * 1000;
        const tpw = dur / wordsData.length;
        wordsData.forEach((_, i) => {
          const id = setTimeout(() => updateWordHighlight(i), i * tpw);
          subtitleTimeouts.push(id);
        });
      }, { once: true });
    }

    audioEl.onended = () => {
      if (token !== currentPlayToken) return;
      try { storyPlayer.classList.remove('animate-ken-burns'); } catch {}
      wordEls.forEach(el => el && el.classList.remove('highlight', 'current-word', 'sung'));
      lineEls.forEach(el => el && el.classList.remove('active'));
      subtitleContainer.style.display = 'none';
      subtitleTimeouts = [];
    };
  }

  // ===== 关闭全屏 =====
  function closeStory() {
    modal?.classList.add('hidden');
    storyPlayer.classList.remove('animate-ken-burns');
    stopCurrentAudio();

    // 回首页置顶最新一批
    if (lastBatchElements && lastBatchElements.length > 0) {
      for (let i = lastBatchElements.length - 1; i >= 0; i--) {
        const el = lastBatchElements[i];
        if (el && el.parentElement === gallery) gallery.prepend(el);
      }
    }
  }
  closeModalBtn?.addEventListener('click', closeStory);

  // ===== 全屏内上下切换（触摸 & 滚轮）=====
  let touchStartY = 0;
  let navLock = false;
  const NAV_THROTTLE_MS = 250;

  modal?.addEventListener('touchstart', (e) => {
    tryUnlockAudio();
    touchStartY = e.changedTouches[0].screenY;
  }, { passive: true });

  modal?.addEventListener('touchend', async (e) => {
    const dy = touchStartY - e.changedTouches[0].screenY;
    if (Math.abs(dy) > 50) {
      if (dy > 0) await nextStory();
      else previousStory();
    }
  }, { passive: true });

  const wheelHandler = async (e) => {
    if (modal?.classList.contains('hidden')) return;
    e.preventDefault();
    e.stopPropagation();
    if (navLock) return;
    navLock = true;
    setTimeout(() => (navLock = false), NAV_THROTTLE_MS);
    if (e.deltaY > 0) await nextStory();
    else previousStory();
  };
  modal?.addEventListener('wheel', wheelHandler, { passive: false });
  window.addEventListener('wheel', wheelHandler, { passive: false });

  async function nextStory() {
    tryUnlockAudio(); // 再保险一次解锁
    const atTail = (currentStoryIndex % 4 === 3);
    if (atTail && !isLoading) {
      await loadNewStories({ insert: 'append', forceRefresh: true });
    }
    if (currentStoryIndex < storiesData.length - 1) {
      currentStoryIndex++;
      await playCurrentStory();
    }
  }
  function previousStory() {
    tryUnlockAudio();
    if (currentStoryIndex > 0) {
      currentStoryIndex--;
      playCurrentStory();
    }
  }

  // 键盘（桌面）
  document.addEventListener('keydown', async (e) => {
    if (modal?.classList.contains('hidden')) return;
    switch (e.key) {
      case 'Escape': return closeStory();
      case 'ArrowDown':
      case 'ArrowRight':
        e.preventDefault(); return await nextStory();
      case 'ArrowUp':
      case 'ArrowLeft':
        e.preventDefault(); return previousStory();
    }
  });

  // ===== 首次加载 =====
  loadNewStories({ insert: 'append', forceRefresh: false });
});
