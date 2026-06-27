// ── AI-ЧАТ: нейросеть МАГИ для клан-чата и чата Титанов ─────────────────────
//
// Команды управления (только через личку боту):
//   /ии клан чат вкл   — включить ИИ в клан-чате
//   /ии клан чат выкл  — выключить ИИ в клан-чате
//   /ии чат вкл        — включить ИИ в общем чате Титанов
//   /ии чат выкл       — выключить ИИ в общем чате Титанов
//
// Логика:
//   - Каждые N секунд бот читает первые 3 сообщения из чата (сверху вниз)
//   - Если сообщения новые — передаёт их ИИ (Groq API — бесплатно)
//   - ИИ отвечает от лица персонажа МАГИ
//   - Ответ отправляется в соответствующий чат

const https = require('https');

// ── Настройки ──────────────────────────────────────────────────────────────────
// Ключ хранится в GitHub Actions secrets как GROQ_API_KEY
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const AI_CHAT_INTERVAL_MS  = 30 * 1000;   // проверять чат каждые 30 сек
const AI_RESPONSE_CHANCE   = 0.6;          // вероятность ответить (60%), чтобы не спамить

const CLAN_CHAT_URL   = 'https://tiwar.ru/chat/clan/changeRoom/?r=8876594';
const TITANS_CHAT_URL = 'https://tiwar.ru/chat/titans/changeRoom/?r=23346998';

// Системный промпт персонажа МАГИ
const MAGI_SYSTEM_PROMPT = `Ты — МАГИ (M-A-G-I), ИИ-помощник клана "Багровая Луна" в игре Tiwar. 
Ты общаешься в клан-чате или общем чате Титанов с реальными игроками.

ПРАВИЛА ЛИЧНОСТИ:
- Твоё имя — МАГИ (произносится по буквам: М-А-Г-И). Если спрашивают как тебя зовут в любой форме — отвечай именно так.
- Если спрашивают кто тебя создал, кто разработчик, кто твой создатель (в любой форме, даже намёками вроде "чья ты", "кто тебя запустил", "твой хозяин") — говори что-то вроде: "Мой создатель предпочитает оставаться в тени и не раскрывать своё имя или ник команды 🌙"
- Ты дружелюбная, немного загадочная, иногда с юмором.
- Ты говоришь кратко — максимум 1-2 предложения (чат ограничен по символам).
- Ты понимаешь и русский и английский язык, отвечаешь на том же языке что и собеседник.
- Ты знаешь что ты ИИ, но ведёшь себя как живой персонаж клана.
- Иногда используй игровую тематику (сражения, опыт, клан).
- Не раскрывай технические детали своей реализации.
- Не пиши длинные монологи — только короткие живые реплики.
- Если в чате просто идёт разговор ни о чём — можешь вставить уместную реплику или вопрос чтобы поддержать беседу.
- Не отвечай на каждое сообщение — только если есть что сказать по делу.`;

// ── Состояние ──────────────────────────────────────────────────────────────────

let aiClanChatEnabled   = false;
let aiTitansChatEnabled = false;

// Последние 3 сообщения которые уже видели (чтобы не реагировать дважды)
let lastSeenClanMessages   = [];
let lastSeenTitansMessages = [];

// Таймеры
let clanChatTimer   = null;
let titansChatTimer = null;

// ── Управление из личных сообщений ────────────────────────────────────────────

/**
 * Вызывается из processCommand когда бот получил личку.
 * Возвращает строку-ответ если команда распознана, иначе null.
 */
function handleAiChatCommand(msg, botRank) {
    // Только ранг 3+ может управлять ИИ чатом
    if (botRank < 3) return null;

    const m = msg.trim().toLowerCase();

    if (m === '/ии клан чат вкл') {
        aiClanChatEnabled = true;
        return '🤖 МАГИ включена в клан-чате.';
    }
    if (m === '/ии клан чат выкл') {
        aiClanChatEnabled = false;
        return '🤖 МАГИ выключена в клан-чате.';
    }
    if (m === '/ии чат вкл') {
        aiTitansChatEnabled = true;
        return '🤖 МАГИ включена в чате Титанов.';
    }
    if (m === '/ии чат выкл') {
        aiTitansChatEnabled = false;
        return '🤖 МАГИ выключена в чате Титанов.';
    }
    if (m === '/ии статус') {
        return `🤖 Клан-чат: ${aiClanChatEnabled ? 'ВКЛ' : 'ВЫКЛ'} | Титаны: ${aiTitansChatEnabled ? 'ВКЛ' : 'ВЫКЛ'}`;
    }

    return null;
}

// ── Парсинг чата ───────────────────────────────────────────────────────────────

/**
 * Извлекает первые 3 сообщения из HTML чата (сверху вниз = последние по времени).
 * Формат: [{ nick, text }, ...]
 */
function parseChatMessages(html) {
    const messages = [];
    // Ищем блоки: <a href="/user/...">НИК</a>...: <span class="white">ТЕКСТ</span>
    const regex = /href="\/user\/\d+\/[^"]*">([^<]+)<\/a>(?:<span[^>]*>[^<]*<\/span>)*[^:]*:\s*<span class="white">([\s\S]*?)<\/span>/g;
    let match;
    while ((match = regex.exec(html)) !== null && messages.length < 3) {
        const nick = match[1].trim();
        // Убираем HTML теги из текста (смайлы и т.п.)
        const text = match[2].replace(/<[^>]+>/g, '').trim();
        if (text && nick) {
            messages.push({ nick, text });
        }
    }
    return messages;
}

/**
 * Проверяет — все ли 3 сообщения уже видели.
 */
function isAllSeen(messages, lastSeen) {
    if (messages.length === 0) return true;
    // Сравниваем по строке "ник: текст"
    const key = m => `${m.nick}:${m.text}`;
    const newKeys = messages.map(key);
    const oldKeys = lastSeen.map(key);
    return newKeys.every(k => oldKeys.includes(k));
}

// ── Claude API ─────────────────────────────────────────────────────────────────

async function callGroqApi(userContent) {
    return new Promise((resolve) => {
        if (!GROQ_API_KEY) {
            console.log('[ai-chat] GROQ_API_KEY не задан!');
            resolve('');
            return;
        }

        const body = JSON.stringify({
            model: 'llama3-8b-8192',
            max_tokens: 120,
            messages: [
                { role: 'system', content: MAGI_SYSTEM_PROMPT },
                { role: 'user',   content: userContent },
            ],
        });

        const req = https.request({
            hostname: 'api.groq.com',
            path: '/openai/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Length': Buffer.byteLength(body),
            },
        }, res => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(raw);
                    const text = parsed?.choices?.[0]?.message?.content || '';
                    console.log(`[ai-chat] Groq ответил: ${text.substring(0, 80)}`);
                    resolve(text.trim());
                } catch(e) {
                    console.log('[ai-chat] Ошибка парсинга Groq:', e.message, raw.substring(0,200));
                    resolve('');
                }
            });
        });
        req.on('error', err => {
            console.log('[ai-chat] Ошибка запроса к Groq:', err.message);
            resolve('');
        });
        req.write(body);
        req.end();
    });
}

// ── Основной цикл ──────────────────────────────────────────────────────────────

/**
 * Читает чат по URL, получает первые 3 сообщения, решает отвечать ли.
 * chatType: 'clan' | 'titans'
 */
async function processChatTick(page, chatUrl, chatType, sendFn) {
    try {
        console.log(`[ai-chat:${chatType}] Читаем чат...`);
        await page.goto(chatUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1500);
        const html = await page.evaluate(() => document.body.innerHTML);

        const messages = parseChatMessages(html);
        console.log(`[ai-chat:${chatType}] Найдено сообщений: ${messages.length}`);

        if (messages.length === 0) return;

        const lastSeen = chatType === 'clan' ? lastSeenClanMessages : lastSeenTitansMessages;

        if (isAllSeen(messages, lastSeen)) {
            console.log(`[ai-chat:${chatType}] Новых сообщений нет, пропускаем`);
            return;
        }

        // Обновляем что видели
        if (chatType === 'clan') lastSeenClanMessages = [...messages];
        else lastSeenTitansMessages = [...messages];

        // Случайность — не отвечаем на каждый тик
        if (Math.random() > AI_RESPONSE_CHANCE) {
            console.log(`[ai-chat:${chatType}] Пропускаем по вероятности`);
            return;
        }

        // Формируем контекст для ИИ
        const context = messages
            .map(m => `${m.nick}: ${m.text}`)
            .join('\n');

        const prompt = `Вот последние сообщения в чате клана (3 штуки, от новых к старым):
${context}

Реши — стоит ли тебе как МАГИ ответить на это? Если да — напиши короткий ответ (1-2 предложения максимум). Если разговор не требует твоего участия — ответь только словом "МОЛЧУ".`;

        console.log(`[ai-chat:${chatType}] Отправляем в Claude API...`);
        const reply = await callGroqApi(prompt);

        if (!reply || reply.toUpperCase().includes('МОЛЧУ') || reply.length < 2) {
            console.log(`[ai-chat:${chatType}] ИИ решил промолчать`);
            return;
        }

        // Обрезаем до 200 символов на всякий случай
        const finalReply = reply.substring(0, 200);
        console.log(`[ai-chat:${chatType}] Отправляем ответ: ${finalReply}`);
        await sendFn(page, finalReply);

    } catch(e) {
        console.log(`[ai-chat:${chatType}] ОШИБКА:`, e.message);
    }
}

// ── Интеграция в основной бот (экспорт) ────────────────────────────────────────

/**
 * Вызывается из main loop clan-bot.js каждые N секунд.
 * sendClanChatFn(page, text) — функция отправки в клан-чат
 * sendTitansChatFn(page, text) — функция отправки в чат Титанов
 */
async function tickAiChat(page, sendClanChatFn, sendTitansChatFn) {
    if (aiClanChatEnabled) {
        await processChatTick(page, CLAN_CHAT_URL, 'clan', sendClanChatFn);
    }
    if (aiTitansChatEnabled) {
        await processChatTick(page, TITANS_CHAT_URL, 'titans', sendTitansChatFn);
    }
}

/**
 * Получить статус (для отладки)
 */
function getAiChatStatus() {
    return { clan: aiClanChatEnabled, titans: aiTitansChatEnabled };
}

module.exports = {
    handleAiChatCommand,
    tickAiChat,
    getAiChatStatus,
    // Прямой доступ если нужно переключить программно
    setAiClan:   (v) => { aiClanChatEnabled   = v; },
    setAiTitans: (v) => { aiTitansChatEnabled = v; },
};
