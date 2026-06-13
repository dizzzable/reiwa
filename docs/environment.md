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
# 1) reverse proxy из deploy/proxies/<caddy|nginx|angie|traefik>/
# 2) reiwa
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
git pull                          # получить актуальный compose
docker compose pull               # стянуть ghcr.io/dizzzable/reiwa:latest
docker compose up -d              # пересоздать reiwa + reiwa-bot
```

---

## 5. Про `docker-compose.dev.yml` (НЕ как override у rezeis)

Важное отличие от rezeis: у reiwa dev-файл называется
`docker-compose.dev.yml`, и Docker Compose **НЕ подхватывает его
автоматически** — его нужно указывать явно:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Это **только для локальной разработки** (bind-mount исходников, `tsx watch`,
vite HMR, образы `reiwa-dev`). В продакшене его использовать НЕ нужно —
прод-стек поднимается обычным `docker compose up -d` на базовом
`docker-compose.yml` (образ из ghcr).

То есть на вопрос «если перенести dev-настройки в `docker-compose.yml`,
заработает ли обычными командами?» — для reiwa ответ: dev-слой для прода
не нужен вовсе, прод-стек самодостаточен. Авто-подхват «обычными командами»
есть только у файла с именем `docker-compose.override.yml` — у reiwa в проде
такого файла нет, и он не требуется.
