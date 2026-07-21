# Reiwa v0.9.6.39

💳 **Согласие на сохранение карты при оплате и продлении** — галочка перед YooKassa; без согласия карта не привязывается. Панель: **rezeis v0.9.6.58**.

### ✨ Что нового
- **Покупка** — чекбокс «Сохранить карту для автоплатежей» на шаге подтверждения.
- **Продление** — тот же consent на review перед checkout.
- **API** — `savePaymentMethod` + `savePaymentMethodConsent` через BFF → rezeis.

### ✅
- typecheck green
- pairs with rezeis fail-closed resolver

**Diff:** https://github.com/dizzzable/reiwa/compare/v0.9.6.38...v0.9.6.39

---
# Reiwa v0.9.6.38

🔒 **Security hardening** — axios/body-parser/brace-expansion patches + strip npm from runtime image (parity with rezeis Trivy cleanup). Парный admin: **rezeis v0.9.6.56**.

### Fixes
- **web axios** → `1.18.1` (HIGH GHSA batch).
- **body-parser** → `2.3.0` (override, root + web).
- **brace-expansion** → `5.0.7` (web override).
- **Runtime Docker:** remove global npm/npx tree.

### ✅
- `npm audit` root + web (omit=dev): **0 vulnerabilities**.

**Полный список изменений:** https://github.com/dizzzable/reiwa/compare/v0.9.6.37...v0.9.6.38

---
# Reiwa v0.9.6.37

🔧 **Задания: полное описание** — текст description в модалке заданий больше не обрезается `truncate`. Парный admin: **rezeis v0.9.6.55**.

### 🐛
- **quests-icon:** description `whitespace-pre-wrap break-words`; title `line-clamp-2`.

### ✅
- Codex pre-release batch: **PASS** (с admin-патчем).

**Полный список изменений:** https://github.com/dizzzable/reiwa/compare/v0.9.6.36...v0.9.6.37

---
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
