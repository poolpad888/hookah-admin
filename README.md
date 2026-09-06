# Мята — админ кальянной

Веб-админка (учёт табака + смены) и Telegram-бот на одной базе Postgres.

## Переменные окружения (Render → Environment)
| Ключ | Что это |
|---|---|
| `DATABASE_URL` | External Database URL из настроек Postgres на Render |
| `ADMIN_PASSWORD` | пароль для входа в веб-админку |
| `BOT_TOKEN` | токен бота от @BotFather |
| `ADMIN_ID` | твой Telegram id (бот скажет его, если написать ему без доступа); можно несколько через запятую |
| `ANTHROPIC_API_KEY` | ключ Anthropic для распознавания накладных |

Build: `npm install && npm run build` · Start: `npm start`
