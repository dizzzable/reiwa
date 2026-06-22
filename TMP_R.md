Конструктор бота, F3 — premium-эмодзи на кнопках уведомлений (reiwa-сторона).

### ✨ Кастом-эмодзи в кнопках уведомлений и рассылок
- `/notify` и `/notify-broadcast` теперь прогоняют подписи кнопок через `renderButtonLabel`: токены `{{KEY}}`/`:slug:` подставляются (fallback-глиф), а ведущий `:slug:`/`{{KEY}}` с premium-id поднимается в `icon_custom_emoji_id` кнопки (premium-gated). Раньше `:slug:` утекал в подпись буквально.
- Контекст эмодзи берётся из bot-config кеша (`botEmojis`/`customEmojis`/`ownerHasPremium`); при недоступности кеша подписи рендерятся как есть (graceful degradation).

### 🧪 Тесты
- tsc 0.

**Полная история изменений:** https://github.com/dizzzable/reiwa/compare/v0.9.5.42...v0.9.5.43
