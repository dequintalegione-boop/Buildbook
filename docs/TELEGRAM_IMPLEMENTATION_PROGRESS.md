# Прогресс по telegram-development-plan.md

Ветка: `feature/telegram-plan-stage1-3` (локально).

## Сделано в этом инкременте

### Этап 1 — аудит
- `docs/TELEGRAM_STAGE1_AUDIT.md` — карта кода и gap analysis.

### Этап 3 — управление
- `POST /api/telegram/restart` в `host/local-api.mjs`
- UI: кнопки Запустить / Остановить / **Перезапустить**
- `controlTelegramService('restart')` с busy-lock

### Этап 5 — белый список
- Meta v2: `{ id, comment, active, addedAt }`
- Неактивные **не** попадают в live gate и `.env`
- UI-таблица с колонками Добавлен / Состояние (активен)

### Этап 2/7 — журнал
- Activity storage limit 2000, API отдаёт до 500
- Фильтр: все / успешные / ошибки
- Поиск по тексту
- Экспорт JSON

## Следующие этапы
4. Installer + выбор папки установки  
6. Enable/disable команд в processor  
2+. Latency/uptime/stale в статусе  
9. Расширенные e2e сценарии  

## Как проверить
```bash
node --test tests/telegram-allowlist-handlers.test.mjs tests/activity-log.test.mjs
# UI: вкладка Telegram → Перезапустить, Белый список, фильтр журнала
```
