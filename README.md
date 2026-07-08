<p align="center">
  <img src="Reiwa-logo.svg" width="160" alt="Reiwa Logo" />
</p>

<h1 align="center">Reiwa</h1>

<p align="center">
  <strong>User-facing edge сервис Rezeis: Telegram-бот, Mini App и web-кабинет в одном образе</strong>
</p>

<p align="center">
  <a href="https://github.com/dizzzable/reiwa/releases/latest"><img src="https://img.shields.io/badge/version-0.9.6.22-blue" alt="Version" /></a>
  <a href="https://github.com/dizzzable/reiwa/pkgs/container/reiwa"><img src="https://img.shields.io/badge/ghcr.io-reiwa-2496ED?logo=docker&logoColor=white" alt="GHCR" /></a>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
  <img src="https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white" alt="Express" />
  <img src="https://img.shields.io/badge/grammY-1.42-009688" alt="grammY" />
  <img src="https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Vite-8-646cff?logo=vite&logoColor=white" alt="Vite" />
</p>

<p align="center">
  <a href="https://github.com/dizzzable/reiwa/releases/latest">Релизы</a> •
  <a href="#-quick-start">Быстрый старт</a> •
  <a href="docs/environment.md">Настройка окружения</a> •
  <a href="#-возможности">Возможности</a> •
  <a href="#-архитектура">Архитектура</a>
</p>

---

## 🎯 О проекте

Reiwa — пользовательский edge/BFF-слой [Rezeis](https://github.com/dizzzable/rezeis). Это лицо сервиса для конечного клиента: один TypeScript-кодбейс отдаёт **Telegram-бота**, **Telegram Mini App** и **web-кабинет (PWA)**. Reiwa не владеет реляционной БД — вся бизнес-истина (платежи, подписки, тарифы) живёт в `rezeis-admin`, а reiwa общается с ним по приватной сети через типизированный `AdminClient`.

**Что выделяет Reiwa:**

- 🧩 **Один образ — три поверхности** — API (Express BFF) + бот (grammY) + воркер + SPA в едином Docker-образе
- 🔌 **BFF-дисциплина** — провайдерские/админские вызовы только на сервере; в браузер не утекают Remnawave-UUID, ссылки провайдеров, токены и device-идентификаторы
- 📱 **Source-aware redirect** — оплата возвращает пользователя туда, откуда он пришёл (Mini App ↔ web)
- 💳 **Единый платёжный UX** — покупка, продление, улучшение и доп-опции одинаковыми полноэкранными мастерами
- 🗑 **Самостоятельное удаление подписки** long-press'ом по карточке с отзывом доступа
- 🎨 **PWA-кабинет** на React 19 + WebGL-эффекты карточек, офлайн через service worker
- 🌍 Полная **i18n** (ru/en) — ноль захардкоженных строк
- 🔐 Redis-сессии, rate-limit, CSRF/Origin-защита, fail-closed в проде

---

## 📦 Готовые Docker-образы

GitHub Container Registry публикует **единый** образ при каждом push'е в `main` и при создании тега.

```bash
# Stable latest (main branch)
docker pull ghcr.io/dizzzable/reiwa:latest

# Pin to a specific release
docker pull ghcr.io/dizzzable/reiwa:v0.9.5.33
```

Доступные теги: `latest` (актуальный main), `v0.9.5.33` (тег релиза), плюс `sha-<short>` для каждого коммита в `main`. Прод-`docker-compose.yml` использует `latest`.

> Один образ обслуживает всё: API на `REIWA_PORT` (по умолчанию `node dist/api/main.js`) раздаёт собранную SPA из `/app/web`, бот — `dist/bot/main.js`, воркер — `dist/worker/main.js`. Роль выбирается командой запуска контейнера.

---

## 🚀 Quick Start

### Установка на VPS (production, готовый образ)

Образ тянется из GHCR — **исходники на сервере не нужны**, только два файла.

```bash
# 1. Каталог установки
mkdir -p /opt/reiwa && cd /opt/reiwa

# 2. Скачать compose и шаблон окружения
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/dizzzable/reiwa/main/docker-compose.yml
curl -fsSL -o .env               https://raw.githubusercontent.com/dizzzable/reiwa/main/.env.example

# 3. Общая docker-сеть с rezeis (создать, если Remnawave/rezeis-стек её ещё
#    не создал — нужна для связи reiwa ↔ rezeis по имени `rezeis:8000`):
docker network create remnawave-network 2>/dev/null || true

# 4. Сгенерировать секреты прямо в .env (создаются на месте):
sed -i "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$(openssl rand -hex 16)|" .env
sed -i "s|^REIWA_COOKIE_SECRET=.*|REIWA_COOKIE_SECRET=$(openssl rand -hex 24)|" .env
sed -i "s|^REZEIS_INTERNAL_SHARED_SECRET=.*|REZEIS_INTERNAL_SHARED_SECRET=$(openssl rand -hex 24)|" .env

# 5. Дозаполнить вручную:
#      REIWA_DOMAIN            публичный домен кабинета (app.example.com)
#      REZEIS_HOST=rezeis      имя контейнера админки на одном VPS (или panel.example.com при split)
#      REZEIS_TOKEN            API-токен, созданный в админке rezeis
#      REZEIS_WEBHOOK_SECRET   = WEBHOOK_SECRET_HEADER из rezeis (если включаете push)
#      BOT_TOKEN, BOT_USERNAME от @BotFather
nano .env

# 6. Запуск (reiwa + reiwa-bot)
docker compose up -d
```

В продакшене сервис **fail-closed**: без Redis или без гарантии secure-cookie
запуск останавливается. Ослабить только осознанно — `REIWA_ALLOW_DEGRADED=true` /
`REIWA_ALLOW_INSECURE_COOKIES=true`. Полный разбор переменных и таблицу
совпадений с rezeis — см. **[docs/environment.md](docs/environment.md)**.

**Обновление:**

```bash
cd /opt/reiwa && docker compose pull && docker compose up -d
```

Reverse proxy: на одном VPS с rezeis удобнее единый Caddy — см.
`caddy-combined` в репозитории rezeis. Отдельные конфиги — в `deploy/proxies/`.

### Локальная разработка / сборка из исходников

Прод-`docker-compose.yml` ссылается только на готовый образ. Чтобы собрать
из исходников локально — build-оверлей:

```bash
git clone https://github.com/dizzzable/reiwa.git && cd reiwa
cp .env.example .env   # заполнить секреты
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build --force-recreate reiwa reiwa-bot
```

«Горячая» разработка (bind-mount + watch/HMR) — `docker-compose.dev.yml`,
либо без docker:

```bash
npm install
npm run dev:api       # Express BFF + раздача SPA
npm run dev:bot       # grammY Telegram bot
npm run dev:worker    # фоновые задачи
cd web && npm install && npm run dev   # фронт (отдельный терминал)
```

**Системные требования:** Node.js 24+, Redis/Valkey 8+, доступный экземпляр `rezeis-admin`.

---

## ✨ Возможности

### 🤖 Telegram-бот (`src/bot`)

- grammY с single-screen контрактом (edit-in-place — экран перерисовывается, а не засоряет чат)
- Определение локали, operator-managed конфиг-кэш, баннеры
- `/start payment_return` — возврат после оплаты из Mini App
- Команды: меню, подписки, покупка, промокод, рефералы, помощь

### 📱 Telegram Mini App + 🌐 web-кабинет (`web/`)

Один React 19 + Vite PWA работает и как Mini App внутри Telegram, и как самостоятельный web-кабинет:

- **Dashboard** — карусель карточек подписок (банк-стайл, WebGL-фон под брендинг), полоса трафика, срок, устройства
- **Покупка** — мастер: тариф → срок → устройство → платёжная система → оплата
- **Продление** — мульти-выбор своих подписок, единый платёж, учёт скидок и промокодов
- **Улучшение тарифа** — выбор подписки → новый тариф → срок → новая цена
- **Доп-опции** — полноэкранный мастер: подписка → опция (трафик/устройства) → оплата; бесплатные активируются мгновенно
- **Удаление подписки** — long-press по карточке → подтверждение → отзыв доступа (финально, без возврата)
- **Устройства** — список HWID, отзыв, перегенерация ссылки
- **Рефералы / партнёрка**, обмен баллов, промокоды, тикеты поддержки, FAQ, настройки, уведомления
- **Онбординг-тур** с подсветкой реальных элементов (включая жест удаления)

### 💳 Платежи

Reiwa не хранит платежи — он проксирует к `rezeis-admin`, который владеет 15 шлюзами. На стороне reiwa:

- Единый выбор платёжной системы с **настоящими SVG-иконками** провайдеров и валют
- **Source-aware** return URL: Mini App → `t.me/<bot>?start=payment_return`, web → `/payment-return`
- Поллинг статуса оплаты + анимированный экран возврата

### 🔐 Безопасность и BFF-дисциплина

- Redis-сессии, `express-rate-limit`, CSRF/Origin allow-list, request-id трейсинг, Helmet
- Brute-force detection с backoff
- Типизированный `UpstreamError` (status/body) — апстрим-ошибки логируются, но **не форвардятся** в браузер
- Наружу не выходят сырые Remnawave-UUID, ссылки провайдеров, токены, device/Telegram-идентификаторы — только стабильные safe-labels и opaque public id

### 🌍 Интернационализация

Полная поддержка ru/en через `react-i18next`. Все пользовательские строки — в `web/src/i18n/{ru,en}.ts`; ноль захардкоженных строк (бренды и формат-локали дат — исключение).

### 📲 PWA

`vite-plugin-pwa` (injectManifest) + собственный service worker (`web/src/sw.ts`): прекэш ассетов, офлайн-старт, устанавливаемость.

---

## 🏗 Архитектура

```
reiwa/
├── src/                          # TypeScript edge (3 entrypoints)
│   ├── api/                      # Express BFF
│   │   ├── routes/               # /api/v1/* (subscription, payments, gateways, ...)
│   │   ├── middleware/           # session, user-identity, CSRF/Origin, rate-limit
│   │   └── lib/                  # safe error responses
│   ├── bot/                      # grammY Telegram bot (single-screen contract)
│   ├── worker/                   # background runtime (scheduled work)
│   ├── infrastructure/
│   │   ├── admin-client/         # AdminTransport (undici pool, bearer + HMAC)
│   │   │   └── namespaces/       # типизированный фасад над internal API rezeis-admin
│   │   ├── redis/                # Redis-backed web sessions
│   │   ├── bot-config/           # operator-managed конфиг бота
│   │   └── i18n/                 # translator + locale packs (ru/en)
│   ├── core/                     # zod-config, errors, enums, version
│   └── lib/                      # client-source, payment-return-url, helpers
├── web/                          # React 19 + Vite PWA (Mini App + web cabinet)
│   └── src/
│       ├── features/             # экран-в-папке (lazy-loaded)
│       ├── components/           # shared UI (Radix + reactbits/WebGL)
│       ├── hooks/                # useLongPress, onboarding tour, session, ...
│       ├── stores/               # Zustand (purchase / renewal / upgrade / addons)
│       ├── assets/{payments,currency}/  # настоящие SVG-иконки
│       ├── i18n/                 # ru.ts + en.ts
│       └── lib/                  # api-client, client-source, utils
├── deploy/proxies/               # caddy / nginx / angie / traefik edge-стек
├── Dockerfile                    # unified image (API + bot + worker + SPA)
├── docker-compose.yml            # production stack
└── .github/workflows/docker-publish.yml  # CI: единый образ → GHCR
```

---

## 🛠 Технологический стек

### Edge (backend)

| Технология | Версия | Назначение |
|-----------|--------|-----------|
| Node.js | 24 | Runtime |
| TypeScript | 6 | Type safety |
| Express | 5 | BFF / HTTP-сервер |
| grammY | 1.42 | Telegram-бот |
| undici | 8 | HTTP-клиент к rezeis-admin (persistent pool) |
| ioredis | 5 | Сессии, rate-limit, brute-force |
| zod | 4 | Валидация конфига и входных данных |
| pino + pino-http | — | Структурное логирование + request-id |
| helmet | 8 | Security headers |
| vitest + fast-check | 4 | Unit + property-based тесты |

### Frontend (web)

| Технология | Версия | Назначение |
|-----------|--------|-----------|
| React | 19 | UI framework |
| TypeScript | 6 | Type safety |
| Vite | 8 | Build tool (rolldown) |
| TanStack Query | 5 | Server state |
| Zustand | 5 | Client state (wizard stores) |
| Radix UI | — | Component primitives |
| Tailwind CSS | 4 | Styling |
| three / @react-three/fiber | — | WebGL-фон карточек |
| Motion | 12 | Анимации |
| react-i18next | — | i18n (ru/en) |
| vite-plugin-pwa + workbox | 1.3 | PWA / service worker |
| sonner | — | Тосты |

### Infrastructure

| Технология | Назначение |
|-----------|-----------|
| Docker + Compose | Контейнеризация (единый образ) |
| Caddy / Nginx / Angie / Traefik | Reverse proxy (TLS 443) |
| GitHub Actions | CI/CD |
| GHCR | Container registry |

---

## 📋 Переменные окружения

Все настройки задаются через окружение и валидируются один раз на старте в [`app.config.ts`](src/core/config/app.config.ts) (zod). Скопируйте `.env.example` → `.env` и заполните `change_me`.

| Переменная | Обязательная | Описание |
|-----------|:---:|-----------|
| `REIWA_DOMAIN` | ✅ | Публичный домен — драйвит CORS/CSRF allow-list, webApp-кнопки и payment-return ссылки бота |
| `REIWA_HOST`, `REIWA_PORT` | — | Хост/порт API (раздаёт также SPA в режиме единого образа; по умолчанию `0.0.0.0:5000`) |
| `BOT_TOKEN` | ✅ | Токен Telegram-бота |
| `BOT_USERNAME` | ✅ | Username бота без `@` — для `t.me/<bot>?start=payment_return` |
| `BOT_MINI_APP`, `BOT_SUPPORT_USERNAME` | — | Режим Mini App и контакт поддержки |
| `REZEIS_HOST`, `REZEIS_PORT` | ✅ | Адрес внутреннего API `rezeis-admin` (источник истины) |
| `REZEIS_TOKEN` | ✅ | Bearer для вызовов rezeis-admin |
| `REZEIS_INTERNAL_SHARED_SECRET` | — | HMAC-подпись внутренних хопов reiwa→admin и reiwa-api→bot (≥32 симв.) |
| `REZEIS_WEBHOOK_SECRET` | ✅ | Проверка входящих вебхуков от rezeis-admin (`X-Rezeis-Signature`) |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_NAME`, `REDIS_PASSWORD` | ✅ | Redis для сессий / rate-limit / FSM бота |
| `REIWA_COOKIE_SECRET`, `REIWA_COOKIE_SECURE` | — | Секрет и `Secure`-флаг session-cookie |
| `REIWA_ALLOW_DEGRADED` | — | `true` — разрешить старт при недоступном Redis (по умолчанию fail-closed) |
| `REIWA_ALLOW_INSECURE_COOKIES` | — | `true` — разрешить небезопасные cookie (только осознанно) |

Полный список с комментариями — в [`.env.example`](.env.example).

---

## 🔌 API (`/api/v1/*`)

Edge-поверхность, которую потребляет кабинет (все эндпоинты за сессией):

- `/api/v1/session` — сессия пользователя
- `/api/v1/subscription`, `/subscriptions/all` — подписки пользователя
- `/api/v1/subscription/renewal-options`, `/upgrade-options` — опции продления/улучшения
- `DELETE /api/v1/subscription/:id` — самостоятельное удаление подписки
- `/api/v1/gateways` — активные платёжные системы
- `/api/v1/payments/checkout`, `/renewal-checkout` — создание оплаты (source-aware)
- `/api/v1/payments/:id` — статус оплаты
- `/api/v1/add-ons/plan/:planId`, `/add-ons/purchase` — доп-опции
- `/api/v1/devices/*` — устройства (список, отзыв, перегенерация ссылки)
- `/api/v1/internal/metrics` — health/метрики reiwa для дашборда rezeis-admin

---

## 🧪 Quality Gates

```bash
# Edge (backend)
npm run check              # TypeScript no-emit (0 errors policy)
npm test                   # vitest unit suite
npm run test:pbt           # property-based (node:test + fast-check)

# Frontend
cd web
npm run build              # tsc -b + vite build
```

> В reiwa ESLint не настроен — гейты держим через `tsc` + тесты + сборку.

---

## 🐳 Docker Build

Единый Dockerfile собирает и обслуживает:

- `dist/api/main.js` — Express BFF (раздаёт SPA из `/app/web`)
- `dist/bot/main.js` — Telegram-бот
- `dist/worker/main.js` — фоновый воркер
- `web/dist/` — собранная PWA

Образ публикуется автоматически в GHCR через [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml) при push в `main` и при тегах `v*`. CI собирает **один** unified-образ (не отдельные backend/web).

`deploy/proxies/` содержит Remnawave-style reverse-proxy стеки (caddy / nginx / angie / traefik), фронтящие кабинет по 443 с bring-your-own сертификатом — см. [`deploy/proxies/README.md`](deploy/proxies/README.md).

---

## 🔗 Связь с Rezeis

Reiwa и [`rezeis-admin`](https://github.com/dizzzable/rezeis) версионируются **в lockstep** (одинаковая версия в обоих репозиториях). Reiwa — это лицо для пользователя; админ-истина и операционные инструменты остаются в `rezeis-admin`. Reiwa **не является** копией Remnawave Panel — это Rezeis-owned сервис с интеграцией Remnawave за admin-owned швами.

---

## 📜 История изменений

Полные release notes по каждой версии — на странице [GitHub Releases](https://github.com/dizzzable/reiwa/releases) с детальным changelog.

---

## 📄 Лицензия

MIT — свободное использование, модификация и распространение.

---

## 🤝 Contributing

1. Fork репозитория
2. Создайте feature-ветку: `git checkout -b feature/your-feature`
3. Commit по [Conventional Commits](https://www.conventionalcommits.org/): `feat(scope): description`
4. Push и откройте Pull Request с описанием изменений

Перед PR: `npm run check`, `npm test` и `npm run build` (в `web/`) должны проходить без ошибок.
