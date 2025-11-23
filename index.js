require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const { DateTime } = require('luxon');

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token || token === 'YOUR_TOKEN_HERE') {
    console.error('Please set TELEGRAM_BOT_TOKEN in .env file');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// Keyboards
const mainMenu = {
    reply_markup: {
        keyboard: [
            ['🛌 Сон', '🍼 Годування'],
            ['💩 Підгузок', '🛁 Купання'],
            ['🚶 Прогулянка', '📊 Звіт']
        ],
        resize_keyboard: true
    }
};

const sleepMenu = {
    reply_markup: {
        keyboard: [
            ['▶️ Почати сон', '⏹ Закінчити сон'],
            ['🔙 Назад']
        ],
        resize_keyboard: true
    }
};

const feedMenu = {
    reply_markup: {
        keyboard: [
            ['🍼 130 мл', '🍼 160 мл'],
            ['✏️ Інший об\'єм', '🔙 Назад']
        ],
        resize_keyboard: true
    }
};

// User state for custom volume input
const userStates = {};

const diaperMenu = {
    reply_markup: {
        keyboard: [
            ['💧 Пі-пі', '💩 Ка-ка'],
            ['🤢 Мікс', '🔙 Назад']
        ],
        resize_keyboard: true
    }
};

// State to track ongoing actions (simple in-memory for now, ideally DB)
// For sleep, we need to know if there is an active sleep session.
// We can query the DB for the last sleep record with no endTime.

// Handlers
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Привіт! Я допоможу тобі вести щоденник Лео.', mainMenu);
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Check if user is in custom volume input mode
    if (userStates[chatId] === 'WAITING_VOLUME') {
        const volume = parseInt(text);
        if (!isNaN(volume) && volume > 0) {
            recordFeed(chatId, volume);
            delete userStates[chatId];
        } else {
            bot.sendMessage(chatId, 'Будь ласка, введіть коректний об\'єм (число).');
        }
        return;
    }

    if (text === '🔙 Назад') {
        delete userStates[chatId];
        bot.sendMessage(chatId, 'Головне меню', mainMenu);
        return;
    }

    // Main Menu Routing
    switch (text) {
        case '🛌 Сон':
            bot.sendMessage(chatId, 'Управління сном:', sleepMenu);
            break;
        case '🍼 Годування':
            bot.sendMessage(chatId, 'Оберіть об\'єм:', feedMenu);
            break;
        case '💩 Підгузок':
            bot.sendMessage(chatId, 'Що там у нас?', diaperMenu);
            break;
        case '🛁 Купання':
            recordActivity(chatId, 'BATH', 'Купання');
            break;
        case '🚶 Прогулянка':
            recordActivity(chatId, 'WALK', 'Прогулянка');
            break;
        case '📊 Звіт':
            generateReport(chatId);
            break;

        // Sleep Actions
        case '▶️ Почати сон':
            startSleep(chatId);
            break;
        case '⏹ Закінчити сон':
            endSleep(chatId);
            break;

        // Feed Actions with volume
        case '🍼 130 мл':
            recordFeed(chatId, 130);
            break;
        case '🍼 160 мл':
            recordFeed(chatId, 160);
            break;
        case '✏️ Інший об\'єм':
            userStates[chatId] = 'WAITING_VOLUME';
            bot.sendMessage(chatId, 'Введіть об\'єм суміші в мл:');
            break;

        // Diaper Actions
        case '💧 Пі-пі':
        case '💩 Ка-ка':
        case '🤢 Мікс':
            recordActivity(chatId, 'DIAPER', text);
            break;
    }
});

function startSleep(chatId) {
    // Check if already sleeping
    db.get("SELECT id FROM activities WHERE type = 'SLEEP' AND endTime IS NULL ORDER BY id DESC LIMIT 1", [], (err, row) => {
        if (row) {
            bot.sendMessage(chatId, 'Лео вже спит! Спочатку закінчіть попередній сон.');
        } else {
            const now = new Date().toISOString();
            db.run("INSERT INTO activities (type, startTime) VALUES (?, ?)", ['SLEEP', now], (err) => {
                if (err) console.error(err);
                bot.sendMessage(chatId, 'Сон почався! 💤', mainMenu);
            });
        }
    });
}

function endSleep(chatId) {
    db.get("SELECT id, startTime FROM activities WHERE type = 'SLEEP' AND endTime IS NULL ORDER BY id DESC LIMIT 1", [], (err, row) => {
        if (row) {
            const now = new Date().toISOString();
            db.run("UPDATE activities SET endTime = ? WHERE id = ?", [now, row.id], (err) => {
                if (err) console.error(err);

                const start = DateTime.fromISO(row.startTime);
                const end = DateTime.fromISO(now);
                const diff = end.diff(start, ['hours', 'minutes']).toObject();

                bot.sendMessage(chatId, `Сон закінчено! Тривалість: ${Math.floor(diff.hours)}год ${Math.floor(diff.minutes)}хв. Доброго ранку! ☀️`, mainMenu);
            });
        } else {
            bot.sendMessage(chatId, 'Немає активного сну. Спочатку почніть сон.');
        }
    });
}

function recordActivity(chatId, type, subtype) {
    const now = new Date().toISOString();
    db.run("INSERT INTO activities (type, subtype, startTime) VALUES (?, ?, ?)", [type, subtype, now], (err) => {
        if (err) console.error(err);
        bot.sendMessage(chatId, 'Записано! ✅', mainMenu);
    });
}

function recordFeed(chatId, volume) {
    const now = new Date().toISOString();
    db.run("INSERT INTO activities (type, subtype, startTime, value) VALUES (?, ?, ?, ?)",
        ['FEED', 'Hipp Formula', now, volume.toString()], (err) => {
            if (err) console.error(err);
            bot.sendMessage(chatId, `Записано! ${volume} мл суміші Hipp ✅`, mainMenu);
        });
}

function generateReport(chatId) {
    const today = new Date().toISOString().split('T')[0];
    const startOfDay = `${today}T00:00:00.000Z`;
    const endOfDay = `${today}T23:59:59.999Z`;

    let report = `📊 *Звіт за сьогодні (${today})*\n\n`;

    db.serialize(() => {
        // Sleep
        db.all("SELECT startTime, endTime FROM activities WHERE type = 'SLEEP' AND startTime >= ? AND startTime <= ?", [startOfDay, endOfDay], (err, rows) => {
            let totalSleepMinutes = 0;
            let sleepCount = 0;
            let sleepDetails = '';

            rows.forEach(row => {
                if (row.endTime) {
                    const start = DateTime.fromISO(row.startTime).setZone('Europe/Kiev');
                    const end = DateTime.fromISO(row.endTime).setZone('Europe/Kiev');
                    const duration = end.diff(start, ['hours', 'minutes']).toObject();
                    totalSleepMinutes += end.diff(start, 'minutes').minutes;
                    sleepCount++;

                    sleepDetails += `  ${start.toFormat('HH:mm')} - ${end.toFormat('HH:mm')} (${Math.floor(duration.hours)}г ${Math.floor(duration.minutes)}хв)\n`;
                }
            });

            const hours = Math.floor(totalSleepMinutes / 60);
            const minutes = Math.round(totalSleepMinutes % 60);
            report += `💤 *Сон*: ${sleepCount} раз(ів), всього ${hours}год ${minutes}хв\n`;
            if (sleepDetails) {
                report += sleepDetails;
            }

            // Feeds with volume
            db.all("SELECT startTime, value FROM activities WHERE type = 'FEED' AND startTime >= ? AND startTime <= ?", [startOfDay, endOfDay], (err, rows) => {
                let totalVolume = 0;
                let feedCount = rows.length;
                let feedDetails = '';

                rows.forEach(row => {
                    const time = DateTime.fromISO(row.startTime).setZone('Europe/Kiev');
                    const volume = row.value ? parseInt(row.value) : 0;
                    totalVolume += volume;
                    feedDetails += `  ${time.toFormat('HH:mm')} - ${volume} мл\n`;
                });

                report += `\n🍼 *Годування*: ${feedCount} раз(ів), всього ${totalVolume} мл\n`;
                if (feedDetails) {
                    report += feedDetails;
                }

                // Diapers
                db.all("SELECT subtype, COUNT(*) as count FROM activities WHERE type = 'DIAPER' AND startTime >= ? AND startTime <= ? GROUP BY subtype", [startOfDay, endOfDay], (err, rows) => {
                    report += `\n💩 *Підгузки*:\n`;
                    rows.forEach(row => {
                        report += `- ${row.subtype}: ${row.count}\n`;
                    });

                    // Bath
                    db.get("SELECT COUNT(*) as count FROM activities WHERE type = 'BATH' AND startTime >= ? AND startTime <= ?", [startOfDay, endOfDay], (err, row) => {
                        if (row && row.count > 0) {
                            report += `\n🛁 *Купання*: ${row.count} раз(ів)\n`;
                        }

                        // Walk
                        db.get("SELECT COUNT(*) as count FROM activities WHERE type = 'WALK' AND startTime >= ? AND startTime <= ?", [startOfDay, endOfDay], (err, row) => {
                            if (row && row.count > 0) {
                                report += `🚶 *Прогулянка*: ${row.count} раз(ів)\n`;
                            }

                            bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
                        });
                    });
                });
            });
        });
    });
}

console.log('Leo Bot is running...');
