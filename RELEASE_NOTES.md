# Reiwa v0.9.6.36

🤖 **AI-Support в кабинете + ключ только из панели** — «Быстрая помощь», full-screen chat, баннер на новом тикете; credentials panel-only (encrypted в rezeis). Парный admin: **rezeis v0.9.6.54**.

### 🐛 / поведение
- **UX:** иконка ✨ на Support → `/support/ai`; dismissible AI-first banner на «Новый тикет»; empty list CTA; fail-closed если AI выключен.
- **Ключ:** `OPENAI_*` env **игнорируются**; runtime из `/internal/ai-config` (apiKey decrypt на BFF).
- **Промпт:** recommendations-only, tools `get_tariffs` / `get_faq`; null-safe content в UI.
- Bot `/support` AI — тот же panel source.

### ✅ Гейты
- Codex pre-release: PASS (panel-only, fail-closed, tools whitelist).
- csrf smoke + rezeis cipher/anonymize suites green.

**Полный список изменений:** https://github.com/dizzzable/reiwa/compare/v0.9.6.35...v0.9.6.36

---
# Reiwa v0.9.6.35

🛡️ **Лимит мульти-подписок в кабинете + bootstrap privacy + CSRF** — при полном слоте нельзя купить ещё одну подписку; add-on/renew/upgrade остаются. Парный admin: **rezeis v0.9.6.53**.

### 🐛 Исправления / поведение
- **Мульти-подписки:** action-policy отдаёт `maxSubscriptions` / `activeSubscriptionCount` / `limitReached` (effective max = max(user, multi default)).
- **Hard block NEW/ADDITIONAL:** dashboard Buy, `/plans`, `/purchase`, checkout + partner balance → toast/alert + сервер `SUBSCRIPTION_LIMIT_REACHED`.
- **Не режется:** докупка add-on к существующей, RENEW, UPGRADE, re-offer при продлении.
- **CSRF:** same-origin Host **или** `REIWA_DOMAIN` (Mini App footgun).
- **Bootstrap:** product codes публичные; ops-`debug` только для `BOT_DEV_ID` после валидного initData.
- **Request aborted:** warn + 499, без ERROR-карточки оператору.

### ✅ Гейты
- `csrf-protection.test.ts` (4), `access-mode` (15).
- Codex quality pass (capacity matrix + privacy).

**Полный список изменений:** https://github.com/dizzzable/reiwa/compare/v0.9.6.34...v0.9.6.35

---
