document.addEventListener('DOMContentLoaded', () => {
    const gallery = document.getElementById('gallery');
    const loader = document.getElementById('loader');
    const modal = document.getElementById('story-modal');
    const storyPlayer = document.getElementById('story-player');
    const subtitleContainer = document.getElementById('subtitle-container');
    const storyLoader = document.getElementById('story-loader');
    const closeModalBtn = document.getElementById('close-modal');

    let isLoading = false;
    let storiesData = []; // 用于存储所有生成的数据

    // 播放音频的全局变量
    let currentAudio = null;
    let subtitleTimeout = null;

    // 加载初始故事
    loadNewStories();

    // 无限滚动
    window.addEventListener('scroll', () => {
        if (!isLoading && window.innerHeight + window.scrollY >= document.body.offsetHeight - 200) {
            loadNewStories();
        }
    });

    async function loadNewStories() {
        if (isLoading) return;
        isLoading = true;
        loader.classList.remove('hidden');

        try {
            // 1. 从后端获取故事创意
            const response = await fetch('/api/get-story-ideas');
            const data = await response.json();
            
            // 为每个创意卡片创建占位符
            const storyPlaceholders = data.stories.map((storyIdea, index) => {
                const item = document.createElement('div');
                item.className = 'gallery-item';
                item.innerHTML = '<div class="spinner"></div>';
                gallery.appendChild(item);
                return { ...storyIdea, element: item, id: storiesData.length + index };
            });

            // 2. 并行生成所有图片
            await Promise.all(storyPlaceholders.map(async (storyData) => {
                try {
                    const imgResponse = await fetch('/api/generate-image', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ prompt: storyData.prompt }),
                    });
                    const imgData = await imgResponse.json();
                    
                    const img = document.createElement('img');
                    img.src = `data:image/png;base64,${imgData.base64}`;
                    storyData.imageUrl = img.src; // 保存图片数据
                    
                    storyData.element.innerHTML = ''; // 清空spinner
                    storyData.element.appendChild(img);
                    storyData.element.dataset.id = storyData.id;

                    storyData.element.addEventListener('click', () => openStory(storyData.id));
                } catch (imgError) {
                    console.error('Image generation failed for prompt:', storyData.prompt, imgError);
                    storyData.element.innerHTML = '图片生成失败';
                }
            }));

            storiesData.push(...storyPlaceholders);

        } catch (error) {
            console.error('Failed to load new stories:', error);
            loader.innerText = '加载失败，请刷新重试。';
        } finally {
            isLoading = false;
            loader.classList.add('hidden');
        }
    }

    async function openStory(id) {
        const storyData = storiesData.find(s => s.id == id);
        if (!storyData || !storyData.imageUrl) return;

        // 停止当前可能正在播放的任何音频
        stopCurrentAudio();
        
        storyPlayer.style.backgroundImage = `url(${storyData.imageUrl})`;
        subtitleContainer.innerHTML = '';
        modal.classList.remove('hidden');
        storyLoader.classList.remove('hidden');

        try {
            // 3. 实时生成语音和时间戳
            const speechResponse = await fetch('/api/generate-speech', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: storyData.story }),
            });
            const speechData = await speechResponse.json();

            storyLoader.classList.add('hidden');
            storyPlayer.classList.add('animate-ken-burns');
            
            // 播放音频和字幕
            playAudioWithSubtitles(speechData.audioContent, speechData.timepoints, storyData.story);

        } catch (error) {
            console.error('Failed to generate speech:', error);
            storyLoader.innerText = '语音生成失败';
        }
    }

    function playAudioWithSubtitles(audioBase64, timepoints, fullText) {
        const audioBlob = new Blob([Uint8Array.from(atob(audioBase64), c => c.charCodeAt(0))], { type: 'audio/mpeg' });
        const audioUrl = URL.createObjectURL(audioBlob);
        currentAudio = new Audio(audioUrl);
        currentAudio.play();

        // 准备字幕
        subtitleContainer.innerHTML = `<span>${fullText}</span>`;
        const textNode = subtitleContainer.querySelector('span');

        let lastIndex = 0;
        timepoints.forEach(point => {
            const timeInMs = point.timeSeconds * 1000;
            setTimeout(() => {
                const textBefore = fullText.substring(0, point.charStart);
                const highlightedText = fullText.substring(point.charStart, point.charStart + point.charLength);
                const textAfter = fullText.substring(point.charStart + point.charLength);

                textNode.innerHTML = 
                    `${textBefore}` +
                    `<span class="highlight">${highlightedText}</span>` +
                    `${textAfter}`;

            }, timeInMs);
        });

        currentAudio.onended = () => {
            storyPlayer.classList.remove('animate-ken-burns');
            subtitleContainer.querySelector('.highlight').classList.remove('highlight');
        };
    }

    function stopCurrentAudio() {
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.src = ''; // 释放资源
            currentAudio = null;
        }
        if (subtitleTimeout) {
            clearTimeout(subtitleTimeout);
        }
    }

    function closeStory() {
        modal.classList.add('hidden');
        storyPlayer.classList.remove('animate-ken-burns');
        stopCurrentAudio();
    }

    closeModalBtn.addEventListener('click', closeStory);
});

// CSS中需要为.highlight添加样式
// 在style.css中加入：
// #subtitle-container .highlight { color: #ffff00; font-weight: bold; }