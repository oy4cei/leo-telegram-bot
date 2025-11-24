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
            ['🚶 Прогулянка', '📊 Звіти']
        ],
        resize_keyboard: true
    }
};

const reportMenu = {
    reply_markup: {
        keyboard: [
            ['📅 За сьогодні', '🗓 За тиждень'],
            ['🔙 Назад']
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
    if (userStates[chatId] && userStates[chatId].state === 'WAITING_VOLUME') {
        const volume = parseInt(text);
        if (!isNaN(volume) && volume > 0) {
            recordFeed(chatId, volume);
            delete userStates[chatId];
        } else {
            bot.sendMessage(chatId, 'Будь ласка, введіть коректний об\'єм (число).');
        }
        return;
    }

    // Check if user is in sleep input mode
    if (userStates[chatId] && userStates[chatId].state === 'WAITING_SLEEP_START') {
        // Check for interval format "14:00-15:30" or "14:00 15:30"
        const intervalMatch = text.match(/^(\d{1,2}:\d{2})[\s\-](\d{1,2}:\d{2})$/);
        if (intervalMatch) {
            const startTime = intervalMatch[1];
            const endTime = intervalMatch[2];
            recordManualSleep(chatId, startTime, endTime);
            delete userStates[chatId];
            return;
        }

        if (isValidTime(text)) {
            userStates[chatId].state = 'WAITING_SLEEP_END';
            userStates[chatId].startTime = text;
            bot.sendMessage(chatId, 'Введіть час закінчення (ГГ:ХХ):');
        } else {
            bot.sendMessage(chatId, 'Невірний формат. Введіть час (наприклад 14:30) або інтервал (14:00-15:30).');
        }
        return;
    }

    if (userStates[chatId] && userStates[chatId].state === 'WAITING_SLEEP_END') {
        if (isValidTime(text)) {
            const startTime = userStates[chatId].startTime;
            const endTime = text;
            recordManualSleep(chatId, startTime, endTime);
            delete userStates[chatId];
        } else {
            bot.sendMessage(chatId, 'Невірний формат. Введіть час у форматі ГГ:ХХ (наприклад, 16:00).');
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
        case '📊 Звіти':
            bot.sendMessage(chatId, 'Оберіть період:', reportMenu);
            break;
        case '📅 За сьогодні':
            generateReport(chatId);
            break;
        case '🗓 За тиждень':
            generateWeeklyReport(chatId);
            break;

        // Sleep Actions
        case '📝 Записати сон':
            userStates[chatId] = { state: 'WAITING_SLEEP_START' };
            bot.sendMessage(chatId, 'Введіть час початку (ГГ:ХХ) або інтервал (наприклад 14:00-15:30):');
            break;

        // Feed Actions with volume
        case '🍼 130 мл':
            recordFeed(chatId, 130);
            break;
        case '🍼 160 мл':
            recordFeed(chatId, 160);
            break;
        case '✏️ Інший об\'єм':
            userStates[chatId] = { state: 'WAITING_VOLUME' };
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

function isValidTime(timeStr) {
    const regex = /^([0-9]{1,2}):([0-5][0-9])$/;
    return regex.test(timeStr);
}

function recordManualSleep(chatId, startTimeStr, endTimeStr) {
    const today = DateTime.now().setZone('Europe/Kiev').toISODate(); // YYYY-MM-DD

    // Helper to parse time string like "9:30" or "14:00"
    const parseTime = (timeStr) => {
        const parts = timeStr.split(':');
        const hour = parts[0].padStart(2, '0');
        const minute = parts[1];
        return `${hour}:${minute}`;
    };

    const startFormatted = parseTime(startTimeStr);
    const endFormatted = parseTime(endTimeStr);

    let startDateTime = DateTime.fromFormat(`${today} ${startFormatted}`, 'yyyy-MM-dd HH:mm', { zone: 'Europe/Kiev' });
    let endDateTime = DateTime.fromFormat(`${today} ${endFormatted}`, 'yyyy-MM-dd HH:mm', { zone: 'Europe/Kiev' });

    if (!startDateTime.isValid || !endDateTime.isValid) {
        bot.sendMessage(chatId, 'Помилка формату часу. Спробуйте ще раз.');
        return;
    }

    // Handle overnight sleep (if end time is earlier than start time, assume next day)
    if (endDateTime < startDateTime) {
        endDateTime = endDateTime.plus({ days: 1 });
    }

    const startISO = startDateTime.toUTC().toISO();
    const endISO = endDateTime.toUTC().toISO();

    db.run("INSERT INTO activities (type, startTime, endTime) VALUES (?, ?, ?)", ['SLEEP', startISO, endISO], (err) => {
        if (err) console.error(err);

        const diff = endDateTime.diff(startDateTime, ['hours', 'minutes']).toObject();
        bot.sendMessage(chatId, `Записано! Сон з ${startTimeStr} до ${endTimeStr} (${Math.floor(diff.hours)}г ${Math.floor(diff.minutes)}хв) ✅`, mainMenu);
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
    // ... (existing logic remains, just wrapped in function)
    generateReportLogic(chatId, startOfDay, endOfDay, report);
}

function generateWeeklyReport(chatId) {
    const end = DateTime.now().setZone('Europe/Kiev');
    const start = end.minus({ days: 7 });

    const startStr = start.toISODate() + 'T00:00:00.000Z';
    const endStr = end.toISODate() + 'T23:59:59.999Z';

    let report = `🗓 *Звіт за тиждень (${start.toFormat('dd.MM')} - ${end.toFormat('dd.MM')})*\n\n`;
    generateReportLogic(chatId, startStr, endStr, report);
}

function generateReportLogic(chatId, startTime, endTime, initialReport) {
    let report = initialReport;

    db.serialize(() => {
        // Sleep
        db.all("SELECT startTime, endTime FROM activities WHERE type = 'SLEEP' AND startTime >= ? AND startTime <= ?", [startTime, endTime], (err, rows) => {
            let totalSleepMinutes = 0;
            let sleepCount = 0;

            rows.forEach(row => {
                if (row.endTime) {
                    const start = DateTime.fromISO(row.startTime).setZone('Europe/Kiev');
                    const end = DateTime.fromISO(row.endTime).setZone('Europe/Kiev');
                    totalSleepMinutes += end.diff(start, 'minutes').minutes;
                    sleepCount++;
                }
            });

            const hours = Math.floor(totalSleepMinutes / 60);
            const minutes = Math.round(totalSleepMinutes % 60);
            report += `💤 *Сон*: ${sleepCount} раз(ів), всього ${hours}год ${minutes}хв\n`;

            // Feeds with volume
            db.all("SELECT startTime, value FROM activities WHERE type = 'FEED' AND startTime >= ? AND startTime <= ?", [startTime, endTime], (err, rows) => {
                let totalVolume = 0;
                let feedCount = rows.length;

                rows.forEach(row => {
                    const volume = row.value ? parseInt(row.value) : 0;
                    totalVolume += volume;
                });

                report += `\n🍼 *Годування*: ${feedCount} раз(ів), всього ${totalVolume} мл\n`;

                // Diapers
                db.all("SELECT subtype, COUNT(*) as count FROM activities WHERE type = 'DIAPER' AND startTime >= ? AND startTime <= ? GROUP BY subtype", [startTime, endTime], (err, rows) => {
                    report += `\n💩 *Підгузки*:\n`;
                    rows.forEach(row => {
                        report += `- ${row.subtype}: ${row.count}\n`;
                    });

                    // Bath
                    db.get("SELECT COUNT(*) as count FROM activities WHERE type = 'BATH' AND startTime >= ? AND startTime <= ?", [startTime, endTime], (err, row) => {
                        if (row && row.count > 0) {
                            report += `\n🛁 *Купання*: ${row.count} раз(ів)\n`;
                        }

                        // Walk
                        db.get("SELECT COUNT(*) as count FROM activities WHERE type = 'WALK' AND startTime >= ? AND startTime <= ?", [startTime, endTime], (err, row) => {
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
