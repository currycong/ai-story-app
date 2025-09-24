

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const textToSpeech = require('@google-cloud/text-to-speech');
const OpenAI = require('openai');

const app = express();
const port = 3000;

// 初始化API客户端
const speechCacheDir = path.join(__dirname, 'cache', 'tts');
if (!fs.existsSync(speechCacheDir)) {
    fs.mkdirSync(speechCacheDir, { recursive: true });
    console.log('Created TTS cache directory:', speechCacheDir);
}
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GEMINI_API_KEY);
const ttsClient = new textToSpeech.TextToSpeechClient({
  keyFilename: path.join(__dirname, "google-credentials.json"),
});
// 初始化 OpenAI 客户端（如果使用DALL-E）
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // 确保在 .env 文件中设置此变量
});

// 确保缓存目录存在
const cacheDir = path.join(__dirname, 'cache', 'images');
const sessionCacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    console.log('Created cache directory:', cacheDir);
}
if (!fs.existsSync(sessionCacheDir)) {
    fs.mkdirSync(sessionCacheDir, { recursive: true });
}

// 在服务器启动时创建一个会话ID
const SESSION_ID = Date.now().toString();
const SESSION_CACHE_FILE = path.join(sessionCacheDir, `session_${SESSION_ID}.json`);

// 存储当前会话的所有故事
let sessionStories = [];

// 启动时加载最近的会话（如果存在）
function loadLastSession() {
    try {
        if (!fs.existsSync(sessionCacheDir)) {
            fs.mkdirSync(sessionCacheDir, { recursive: true });
            return;
        }
        
        // 查找最近的会话文件
        const files = fs.readdirSync(sessionCacheDir)
            .filter(f => f.startsWith('session_') && f.endsWith('.json'))
            .map(f => ({
                name: f,
                path: path.join(sessionCacheDir, f),
                time: fs.statSync(path.join(sessionCacheDir, f)).mtime
            }))
            .sort((a, b) => b.time - a.time);
        
        if (files.length > 0) {
            // 加载最近的会话
            const lastSession = JSON.parse(fs.readFileSync(files[0].path, 'utf8'));
            sessionStories = lastSession.stories || [];
            console.log(`📂 Loaded ${sessionStories.length} stories from last session`);
            
            // 清理旧的会话文件（保留最近3个）
            if (files.length > 3) {
                files.slice(3).forEach(f => {
                    fs.unlinkSync(f.path);
                    console.log(`🗑️ Deleted old session: ${f.name}`);
                });
            }
        }
    } catch (error) {
        console.error('Error loading last session:', error);
    }
}

// 服务器启动时加载
loadLastSession();

app.use(express.static('public')); // 托管前端文件
app.use(express.json());

// API端点1: 生成故事创意（带会话缓存）
app.get('/api/get-story-ideas', async (req, res) => {
    // 检查是否强制刷新（可通过查询参数控制）
    const forceRefresh = req.query.refresh === 'true';
    
    // 如果已有足够的缓存故事且不强制刷新
    if (!forceRefresh && sessionStories.length >= 4) {
        // 随机返回4个已缓存的故事
        const shuffled = [...sessionStories].sort(() => 0.5 - Math.random());
        const selected = shuffled.slice(0, 4);
        console.log('📦 Using cached session stories');
        return res.json({ stories: selected });
    }
    
    // 需要生成新故事
    console.log('🎨 Generating new stories with Gemini...');
    
    const candidates = [
        "gemini-2.5-flash",
        "gemini-2.0-flash",
        "gemini-1.5-flash",
        "gemini-1.5-pro",
    ];

    // 定义生成配置：强制输出 JSON
    const generationConfig = {
        temperature: 0.7,
        responseMimeType: "application/json",
        responseSchema: {
            type: "OBJECT",
            properties: {
                stories: {
                    type: "ARRAY",
                    items: {
                        type: "OBJECT",
                        properties: {
                            prompt: { type: "STRING" },
                            story: { type: "STRING" }
                        },
                        required: ["prompt", "story"]
                    }
                }
            },
            required: ["stories"]
        }
    };

const userPrompt = `
Create 4 short children's stories for Grade 2 readers (age 7–8).

Language rules (must follow):
1) Use **only simple English words** (Grade 2 level, CEFR A1). Prefer Dolch/Fry sight words.
2) Each story is **60–80 words**. Each sentence has **6–10 words**.
3) Use clear subject–verb–object grammar. Avoid clauses, passive voice, and long words.
4) Use friendly, short words (≤ 8 letters when possible).
5) Make the story vivid and fun, with friendly animals, school, park, space, or sea themes.
6) Keep a warm, kind, and happy tone.
7) At the end of each story, add **one short question** to the child (e.g., “What do you think?”).

Output format:
Return JSON only, like this:
{
  "stories": [
    { "prompt": "<concise visual image prompt in English>", "story": "<English story, 60–80 words, ends with a short question>" },
    ...
  ]
}
`;



    async function tryModel(modelName) {
        const model = genAI.getGenerativeModel({ model: modelName, generationConfig });
        const MAX_ATTEMPTS = 5;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            try {
                const result = await model.generateContent(userPrompt);
                const text = result.response.text();
                return JSON.parse(text);
            } catch (err) {
                const status = err?.status || err?.response?.status;
                if ((status === 429 || status === 503) && attempt < MAX_ATTEMPTS - 1) {
                    const delay = 500 * Math.pow(2, attempt); // 指数退避
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                throw err;
            }
        }
    }

    try {
        let lastErr = null;
        let ideas = null;
        
        for (const m of candidates) {
            try {
                ideas = await tryModel(m);
                break; // 成功则跳出循环
            } catch (e) {
                lastErr = e;
                console.warn(`Model ${m} failed, trying next...`);
            }
        }
        
        if (!ideas) {
            throw lastErr || new Error("All models failed");
        }
        
        // 添加到会话缓存
        ideas.stories.forEach(story => {
            // 检查是否已存在（基于提示词）
            const exists = sessionStories.some(s => s.prompt === story.prompt);
            if (!exists) {
                sessionStories.push(story);
            }
        });
        
        // 保存会话
        const sessionData = {
            sessionId: SESSION_ID,
            timestamp: new Date().toISOString(),
            stories: sessionStories
        };
        fs.writeFileSync(SESSION_CACHE_FILE, JSON.stringify(sessionData, null, 2));
        console.log(`💾 Session saved with ${sessionStories.length} total stories`);
        
        return res.json(ideas);
        
    } catch (error) {
        // 如果 API 失败，尝试使用缓存
        if (sessionStories.length > 0) {
            console.log('⚠️ API failed, using cached stories');
            const shuffled = [...sessionStories].sort(() => 0.5 - Math.random());
            return res.json({ stories: shuffled.slice(0, 4) });
        }
        
        // 如果没有缓存，返回错误
        console.error("Error generating story ideas:", error);
        res.status(500).json({ error: "无法从Gemini获取故事创意" });
    }
});

// API端点2: 根据提示词生成图片（使用缓存机制 + Stability AI）
app.post('/api/generate-image', async (req, res) => {
    const { prompt } = req.body;
    
    if (!prompt) {
        return res.status(400).json({ error: "需要提供提示词" });
    }

    // 生成缓存键：使用提示词的哈希值作为文件名
    const cacheKey = crypto.createHash('md5').update(prompt).digest('hex');
    const cachePath = path.join(cacheDir, `${cacheKey}.txt`); // 存储base64文本
    
    // 检查缓存是否存在
    if (fs.existsSync(cachePath)) {
        console.log(`✅ Cache hit for prompt: "${prompt.substring(0, 50)}..."`);
        try {
            const cachedBase64 = fs.readFileSync(cachePath, 'utf8');
            return res.json({ 
                base64: cachedBase64,
                cached: true  // 标记这是缓存的数据
            });
        } catch (readError) {
            console.error('Error reading cache:', readError);
            // 如果读取失败，继续生成新图片
        }
    }
    
    console.log(`🎨 Cache miss, generating new image for: "${prompt.substring(0, 50)}..."`);

    const apiKey = process.env.STABILITY_AI_API_KEY;
    const stableDiffusionApiUrl = "https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image";

    if (!apiKey) {
        console.error("STABILITY_AI_API_KEY is not configured in .env file.");
        return res.status(500).json({ error: "API密钥未配置" });
    }
    
    const prefix = 'a 7-year-old child\'s storybook illustration, bright vibrant colors, soft lighting, simple shapes, clean outlines, friendly faces, high contrast, flat background';

    try {
        const response = await axios.post(
            stableDiffusionApiUrl,
            {
                text_prompts: [
                    {
                        text: `${prefix}. ${prompt}`,
                        weight: 1
                    },
                    {
                        text: "ugly, deformed, disfigured, watermark, text, signature",
                        weight: -1
                    }
                ],
                cfg_scale: 7,
                clip_guidance_preset: "FAST_BLUE",
                height: 1024,
                width: 1024,
                samples: 1,
                steps: 30
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Authorization": `Bearer ${apiKey}` 
                }
            }
        );
        
        const artifacts = response.data.artifacts;
        if (!artifacts || artifacts.length === 0) {
            console.error("Stability AI API did not return any image artifacts.");
            return res.status(500).json({ error: "API返回的数据不包含图片" });
        }
        
        const base64Data = artifacts[0].base64;
        
        // 保存到缓存
        try {
            fs.writeFileSync(cachePath, base64Data, 'utf8');
            console.log(`💾 Cached image saved: ${cachePath}`);
        } catch (writeError) {
            console.error('Error saving cache:', writeError);
            // 即使缓存失败，也返回生成的图片
        }
        
        res.json({ 
            base64: base64Data,
            cached: false  // 标记这是新生成的
        });

    } catch (error) {
        console.error("Error calling Stability AI API:", error.message);
        if (error.response && error.response.data) {
            console.error("API error details:", error.response.data);
        }
        res.status(500).json({ error: "无法生成图片，请检查服务器日志获取详细信息" });
    }
});

/*
// 备用：使用 OpenAI DALL·E 生成图片
app.post('/api/generate-image-dalle', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: "需要提供提示词" });
  }

  const prefix = 'a 7-year-old child\'s storybook illustration, bright vibrant colors, soft lighting, simple shapes';

  try {
    const imageResponse = await openai.images.generate({
      model: "dall-e-3",
      prompt: `${prefix}. ${prompt}`,
      n: 1,
      size: "1024x1024",
      response_format: 'b64_json'
    });

    const base64Data = imageResponse.data[0].b64_json;
    res.json({ base64: base64Data });

  } catch (error) {
    console.error("Error with OpenAI:", error.message);
    res.status(500).json({ error: "无法生成图片" });
  }
});
*/

// API端点3: 生成语音和时间戳（使用Google Cloud TTS + 缓存，包括timepoints）
app.post('/api/generate-speech', async (req, res) => {
    const { text } = req.body;
    if (!text) {
        return res.status(400).json({ error: "需要提供文本" });
    }

    try {
        // 用文本生成哈希作为缓存文件名
        const cacheKey = crypto.createHash('md5').update(text).digest('hex');
        const cachePath = path.join(speechCacheDir, `${cacheKey}.json`);

        // 如果缓存存在，直接读取返回
        if (fs.existsSync(cachePath)) {
            console.log(`✅ TTS cache hit for: "${text.substring(0, 30)}..."`);
            const cachedData = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
            return res.json({
                audioContent: cachedData.audio,
                timepoints: cachedData.timepoints || [],
                cached: true
            });
        }

        // 如果没有缓存，调用 Google TTS
        const request = {
            input: { text },
            voice: { 
                languageCode: 'en-US', 
                name: 'en-US-Studio-O'
            },
            audioConfig: { 
                audioEncoding: 'MP3',
                speakingRate: 0.7
            },
            enableTimePointing: ['TIMEPOINT_TYPE_WORD']
        };

        const [response] = await ttsClient.synthesizeSpeech(request);

        const audioContent = response.audioContent.toString('base64');
        const timepoints = response.timepoints || [];

        // 保存到缓存 (JSON 格式，包含音频+时间点)
        fs.writeFileSync(cachePath, JSON.stringify({
            audio: audioContent,
            timepoints
        }));

        console.log(`💾 TTS cached: ${cachePath}`);

        res.json({
            audioContent,
            timepoints,
            cached: false
        });

    } catch (error) {
        console.error("Error generating speech:", error.message);
        res.status(500).json({ error: "无法生成语音，请检查服务器日志" });
    }
});


// API端点：手动刷新故事缓存
app.post('/api/refresh-stories', (req, res) => {
    sessionStories = [];
    console.log('🔄 Story cache cleared');
    res.json({ message: '故事缓存已清空，下次请求将生成新故事' });
});

// API端点：清理图片缓存
app.delete('/api/clear-image-cache', (req, res) => {
    try {
        const files = fs.readdirSync(cacheDir);
        let deletedCount = 0;
        
        files.forEach(file => {
            const filePath = path.join(cacheDir, file);
            fs.unlinkSync(filePath);
            deletedCount++;
        });
        
        console.log(`🗑️ Cleared ${deletedCount} cached images`);
        res.json({ message: `清理了 ${deletedCount} 个缓存图片文件` });
    } catch (error) {
        console.error('Error clearing cache:', error);
        res.status(500).json({ error: '清理缓存失败' });
    }
});

// API端点：查看缓存统计
app.get('/api/cache-stats', (req, res) => {
    try {
        // 图片缓存统计
        const imageFiles = fs.readdirSync(cacheDir);
        const imageTotalSize = imageFiles.reduce((sum, file) => {
            const filePath = path.join(cacheDir, file);
            return sum + fs.statSync(filePath).size;
        }, 0);
        
        // 会话缓存统计
        const sessionFiles = fs.readdirSync(sessionCacheDir)
            .filter(f => f.startsWith('session_') && f.endsWith('.json'));
        
        res.json({
            images: {
                count: imageFiles.length,
                totalSize: (imageTotalSize / 1024 / 1024).toFixed(2) + ' MB'
            },
            sessions: {
                count: sessionFiles.length,
                currentStories: sessionStories.length
            },
            currentSessionId: SESSION_ID
        });
    } catch (error) {
        console.error('Error getting cache stats:', error);
        res.status(500).json({ error: '获取缓存统计失败' });
    }
});

// 根路由返回前端页面
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


app.listen(port, () => {
    console.log(`
    ========================================
    🚀 服务器正在 http://localhost:${port} 运行
    📂 会话ID: ${SESSION_ID}
    📚 已加载故事: ${sessionStories.length} 个
    ========================================
    `);
});