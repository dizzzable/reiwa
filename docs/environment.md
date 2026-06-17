# reiwa — Конфигурация окружения и деплой

Справочник по каждой переменной `.env`, какие значения должны совпадать с
rezeis-admin, что важно для продакшена, и какой compose использовать на
одном VPS и на разных.

> Источник истины — `.env.example` (дефолты) и `src/core/config/app.config.ts`
> (валидация zod при старте). reiwa — **stateless edge**: своей реляционной
> БД нет, вся бизнес-логика берётся из rezeis-admin по HTTP. Единственное
> состояние — эфемерное в `reiwa-redis` (сессии, rate-limit, FSM бота, коды).

---

## 1. Как устроена конфигурация

- Контейнеры `reiwa` (API+SPA) и `reiwa-bot` читают **один и тот же `.env`**.
  Это один и тот же образ `ghcr.io/dizzzable/reiwa:latest`, разные команды
  запуска.
- `reiwa-bot` поднимает приватный listener на `BOT_INVALIDATE_PORT` (5100)
  внутри docker-сети — туда `reiwa`-api релеит вебхуки от rezeis. Наружу не
  публикуется. Бот всегда на long-polling (webhook-режима нет).

---

## 2. Справочник переменных

Легенда: **Обяз.** — обязательна; **Прод** — рекомендованное прод-значение.

### reiwa

| Переменная | Назначение | Обяз. | Прод |
|---|---|---|---|
| `REIWA_DOMAIN` | Публичный хост кабинета/Mini App. Голый хост или полный URL; публичный домен → `https://`, `localhost`/docker-имя → `http://`. Используется для webApp-кнопок, реф-ссылок, payment-return, CORS/CSRF. | **да** | `app.example.com` |
| `REIWA_HOST` | Интерфейс, на котором слушает API. | — | `0.0.0.0` |
| `REIWA_PORT` | Порт API (он же отдаёт SPA). | — | `5000` |
| `REIWA_CORS_ORIGIN` | Явный CORS/CSRF origin. Пусто → берётся из `REIWA_DOMAIN`. | — | пусто |

### Подключение к rezeis-admin

| Переменная | Назначение | Обяз. | Прод |
|---|---|---|---|
| `REZEIS_HOST` | Хост админки. **Без точки** → docker-имя → `http://host:port` (один VPS, должно быть `rezeis` — имя контейнера). **С точкой** → публичный домен → `https://host` (split). | **да** | один VPS: `rezeis`; split: `panel.example.com` |
| `REZEIS_PORT` | Порт админки (игнорируется для публичного домена). | — | `8000` |
| `REZEIS_TOKEN` | Bearer-токен для вызовов reiwa→rezeis API. **Создаётся в админке rezeis** (раздел API-токенов) и вставляется сюда. | **да** | JWT из панели, **секрет** |
| `REZEIS_CADDY_TOKEN` / `REZEIS_COOKIE` | Доп. заголовок/cookie, если rezeis за Caddy-auth. | — | пусто |
| `REZEIS_INTERNAL_SHARED_SECRET` | HMAC (≥32 симв.): подписывает исходящие reiwa→rezeis запросы и релей reiwa-api→reiwa-bot. **Живёт только в reiwa**, админке не нужен. | рек. | свой ≥32, **секрет** |
| `REZEIS_WEBHOOK_SECRET` | Секрет для ПРОВЕРКИ входящих вебхуков от rezeis. **Должен совпадать** с `WEBHOOK_SECRET_HEADER` админки. Пусто → приём вебхуков отключён. | для пушей | 64-симв., **= админскому** |

### Бот

| Переменная | Назначение | Обяз. | Прод |
|---|---|---|---|
| `BOT_TOKEN` | Токен бота от @BotFather. | **да** | **секрет** |
| `BOT_SUPPORT_USERNAME` | Хэндл поддержки (fallback, если в админке не задан). `@` убирается. | — | `@YourSupport` |
| `BOT_DEV_ID` | Telegram id разработчика/оператора для внутренних алертов. | — | ваш id |
| `BOT_USERNAME` | Username бота без `@` (для deep-link `?start=payment_return`). | да | `RezeisBot` |
| `BOT_INVALIDATE_PORT` | Порт приватного listener бота (релей вебхуков). | — | `5100` (закомментирован) |

> Mini App включается **из админки** (`features.miniAppEnabled`), не через env.
> Команды бота ставятся автоматически (`setMyCommands`). Поэтому
> `BOT_MINI_APP`, `BOT_SETUP_WEBHOOK`, `BOT_RESET_WEBHOOK`, `BOT_SETUP_COMMANDS`,
> `BOT_DROP_PENDING_UPDATES`, `BOT_SECRET_TOKEN` отсутствуют — они не читаются.

### Redis (свой, эфемерный)

| Переменная | Назначение | Обяз. | Прод |
|---|---|---|---|
| `REDIS_HOST` | Хост Redis reiwa. | — | `reiwa-redis` |
| `REDIS_PORT` / `REDIS_NAME` | Порт / номер БД. | — | `6379` / `0` |
| `REDIS_PASSWORD` | Пароль Redis (общий с контейнером `reiwa-redis`). | **да** | свой, **секрет**, задать до 1-го старта |

### Сессии / cookie / деградация

| Переменная | Назначение | Обяз. | Прод |
|---|---|---|---|
| `REIWA_COOKIE_SECRET` | Секрет для cookie (резерв под подпись). | да | свой, **секрет** |
| `REIWA_COOKIE_SECURE` | Выдавать cookie с флагом `Secure` (только HTTPS). В проде форсится. | — | `true` |
| `REIWA_ALLOW_INSECURE_COOKIES` | Разрешить не-`Secure` cookie в проде (только доверенная сеть/внешний TLS). Иначе API не стартует. | — | `false` |
| `REIWA_ALLOW_DEGRADED` | Дать API стартовать без Redis (сессии/rate-limit/anti-brute тогда не работают). В проде по умолчанию падает закрыто. | — | `false` |

---

## 3. Что должно совпадать с rezeis-admin

| reiwa (`.env`) | rezeis (`.env`) | Совпадение | Зачем |
|---|---|---|---|
| `REZEIS_WEBHOOK_SECRET` | `WEBHOOK_SECRET_HEADER` | **идентично** | проверка подписи вебхуков admin→reiwa |
| `REZEIS_TOKEN` | — (создаётся в панели) | токен из админки | Bearer reiwa→rezeis |
| `REZEIS_HOST` | `REZEIS_DOMAIN` | согласованно | reiwa должен «видеть» rezeis |
| `REIWA_DOMAIN` | `REIWA_URL` | согласованно | куда rezeis шлёт вебхуки |

> `REZEIS_INTERNAL_SHARED_SECRET` — **только reiwa**, в админке не нужен.
> Redis-пароли проектов **разные** (у каждого свой Redis).

---

## 4. Docker Compose: один VPS vs разные

### Один VPS (по умолчанию)

```bash
# 0) общая сеть с rezeis (создать, если её ещё нет)
docker network create remnawave-network 2>/dev/null || true
# 1) reverse proxy: на одном VPS с rezeis удобнее единый caddy-combined (в репо rezeis)
# 2) reiwa (готовый образ из GHCR)
docker compose up -d            # reiwa + reiwa-bot + reiwa-redis
```

`.env`: `REZEIS_HOST=rezeis` (имя контейнера админки в общей сети),
`REIWA_DOMAIN=app.example.com`. Оба проекта в сети `remnawave-network`.

### Разные VPS (split)

Полный чеклист — [`docs/split-vps-deployment.md`](./split-vps-deployment.md).
Кратко: `REZEIS_HOST=panel.example.com` (с точкой → https), на стороне rezeis
`REIWA_URL=https://app.example.com`, оба за reverse-proxy на `:443`.

### Обновление образов

```bash
cd /opt/reiwa
docker compose pull               # стянуть ghcr.io/dizzzable/reiwa:latest
docker compose up -d              # пересоздать reiwa + reiwa-bot
```

Исходники на сервере не нужны. Сборка из исходников локально — через оверлей:
`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.

---

## 5. Сборка из исходников: `docker-compose.build.yml` / `docker-compose.dev.yml`

Прод-`docker-compose.yml` ссылается **только на готовый образ** (`image:`),
без `build:`. Для сборки из исходников есть два оверлея:

- **`docker-compose.build.yml`** — собирает прод-образ из исходников (тест
  реального образа перед пушем):
  ```bash
  docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build --force-recreate reiwa reiwa-bot
  ```
- **`docker-compose.dev.yml`** — «горячая» разработка (bind-mount, `tsx watch`,
  vite HMR, образы `reiwa-dev`):
  ```bash
  docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
  ```

Оба подключаются явно через `-f` и в продакшене НЕ нужны — прод-стек
самодостаточен (`docker compose up -d` тянет образ из GHCR).

## Анонимный чат поддержки (публичный edge)

reiwa отдаёт публичную, бессессионную точку входа в поддержку: посетитель
открывает обращение без входа в аккаунт. reiwa выдаёт httpOnly-cookie
`reiwa_support` с серверным токеном и ретранслирует его в rezeis заголовком
`X-Support-Guest-Token` (rezeis резолвит по hash). Защита от абьюза включена
всегда (выделенные Redis-лимиты + caps на размер/контент).

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `SUPPORT_TURNSTILE_SECRET` | _(пусто)_ | Серверный ключ Cloudflare Turnstile. Когда задан — на создании обращения требуется captcha. |
| `SUPPORT_TURNSTILE_SITE_KEY` | _(пусто)_ | Публичный site-key, отдаётся виджету для рендера челленджа. |

Если оба ключа пусты — captcha отключается, остаётся строгий rate-limit
(создание 5/час/IP, ответы 30/мин/IP, загрузки 12/мин/IP).
