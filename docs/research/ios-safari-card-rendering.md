# Research: карточки подписки не рендерятся + дёрганый рендер на iOS (reiwa web)

**Status:** Research / диагностика. Код НЕ менялся — это разбор, план фикса
и источники. Правки в отдельный патч по согласованию.

**Контекст жалобы:** тестер прислал скрин обычного **мобильного Safari**
(`reiwa.2get.pro` в адресной строке, не Mini App) — карточка подписки видна,
но живой Aurora-фон (WebGL) не отрисовался, плюс сообщалось про дёрганый
(janky) рендер на iOS в целом.

**Важное отличие от прошлого фикса:** релиз v0.9.5.35 (20 июня) уже правил
похожую жалобу — но **строго в контексте Telegram Mini App** на iPhone, и
касался ДРУГОГО механизма (ошибка компиляции шейдера). Этот баг воспроизведён
в обычном Safari-браузере (веб-кабинет), значит причина либо не долечена до
конца, либо это отдельный, второй баг с похожим симптомом. Ниже — оба.

---

## 1. Стек, который рендерит карточки

- Библиотека: **OGL** (`ogl` npm, минималистичный WebGL-wrapper, форк-донор
  reactbits.dev) — НЕ three.js, НЕ react-three-fiber (кроме `Silk.tsx`, который
  не используется картой подписки по умолчанию).
- Дефолтный фон карточки — `Aurora` (`web/src/components/ui/aurora.tsx`):
  один fullscreen-треугольник + фрагментный шейдер `#version 300 es`
  (**требует WebGL2**), simplex-noise аврора, цвет из `brandAuroraStops()`.
- Точка мониторинга: `CardEffectLayer` (`web/src/components/reactbits/card-effect-layer.tsx`)
  — IntersectionObserver решает, монтировать ли эффект; carousel передаёт явный
  `active` (только у ТЕКУЩЕЙ + соседних карточек), но:
  - `/plans` (`tariff-card.tsx`) и списки выбора подписки
    (`subscription-select-card.tsx`, renewal/upgrade/addons) **`active` не
    передают** → там работает только `threshold: 0.01` IntersectionObserver
    без ограничения на количество ОДНОВРЕМЕННО смонтированных контекстов.

---

## 2. Гипотеза A (подтверждена кодом + внешними источниками): множественные живые WebGL-контексты на iOS

### Что происходит в коде
`CardEffectLayer` монтирует **отдельный `<Aurora>` → отдельный `new Renderer()`
→ отдельный WebGL2-контекст** на каждую видимую карточку. На `/plans`
(каталог тарифов) и на экранах выбора подписки (продление/апгрейд/допокупки)
эффект не ограничен единым "активным" слотом — если на экране одновременно
видно, скажем, 3–5 карточек тарифов (даже частично, `threshold: 0.01`), это
**3–5 одновременных живых WebGL-контекстов**.

На скрине тестера видна ТОЛЬКО ОДНА карточка подписки (карусель на
dashboard — там governor `effectActive` есть и работает штатно), поэтому
множественность контекстов не объясняет именно этот скрин напрямую, но
объясняет **общую "дёрганность"**, если пользователь до этого был на `/plans`
или на экране продления с несколькими карточками — контексты создаются и не
всегда корректно освобождаются на iOS до навигации назад.

### Почему это критично именно на iOS Safari/WebKit
- WebKit (Safari iOS, и в Mini App WKWebView) держит **жёсткий лимит
  одновременных WebGL-контекстов на страницу** — исторически ~16 в разных
  тестах, но на факте зависит от версии/памяти устройства и заметно НИЖЕ на
  iPhone, чем на десктопе:
  - https://stackoverflow.com/questions/59140439/allowing-more-webgl-contexts —
    "Not possible to increase the limit."
  - https://stackoverflow.com/questions/52464621/there-are-too-many-active-webgl-contexts-on-this-page-the-oldest-context-will-be-lost
  - При превышении лимита браузер **молча убивает самый старый контекст**
    ("oldest context will be lost") — та карточка визуально чернеет / не
    рисуется, при этом ошибка в консоли не всегда явная для конечного
    пользователя.
- Апрельский форум Apple Developer подтверждает похожее на канвасах с WebGL
  специфично (2D-канвасы не страдают):
  https://developer.apple.com/forums/thread/668999 — "issue appears limited to
  canvases that use WebGL contexts."
- Свежий (2026) отчёт с той же симптоматикой ("WebGL context immediately lost
  on iOS", трикл жалоб именно от iOS-пользователей при рабочем десктопе):
  https://stackoverflow.com/questions/79847768/webgl-context-immediately-lost-on-ios

### Вывод
Наш собственный комментарий в коде (`card-effect-layer.tsx`, строки ~78-82)
**уже описывает именно эту проблему** ("mobile browsers cap contexts at ~8 and
the oldest context will be lost thrash is exactly the flicker users see") —
но текущий governor (`active` prop) реализован ТОЛЬКО в carousel. Экраны
`/plans`, `subscription-select-card` (продление/апгрейд/допокупки) остались не
защищены.

---

## 3. Гипотеза B (подтверждена кодом): resize через `window.resize` вместо `ResizeObserver` + отсутствие context-loss recovery в Aurora

### Разница между Aurora и другими эффектами в том же проекте
Три других OGL-эффекта в проекте (`Plasma.tsx`, `Grainient.tsx`, `RippleGrid.tsx`)
уже используют более надёжный паттерн, которого НЕТ в `Aurora.tsx`:

| | Aurora (дефолт карточки) | Plasma / Grainient |
|---|---|---|
| Resize | `window.addEventListener("resize", ...)` | `new ResizeObserver(setSize)` на контейнере |
| `webglcontextlost`/`restored` | ❌ нет | ✅ есть, отменяет rAF и восстанавливает |
| IntersectionObserver пауза rAF | ❌ нет (полагается только на внешний `CardEffectLayer`) | ✅ есть внутри самого компонента |
| dpr cap | не передаётся (дефолт OGL `dpr=1`) | `Math.min(devicePixelRatio, 2)` |

Почему это важно именно на iOS Safari:
- iOS Safari **не всегда шлёт `window.resize`**, когда реально меняется
  видимая область — классический кейс: сворачивание/разворачивание адресной
  строки при скролле меняет `visualViewport`/layout viewport, но НЕ всегда
  триггерит `window.resize` так же надёжно, как на десктопе:
  - https://stackoverflow.com/questions/18137690/mobile-browsers-dont-fire-up-resize-event-when-hiding-address-bar
  - https://dad-union.com/en/iphone-safari-scroll-resize-event-problem — "This
    behavior differs from an actual window resize."
  - https://johnkavanagh.co.uk/articles/understanding-phantom-window-resize-events-in-ios
- Итог: канвас Aurora может продолжать рисовать в **устаревшем размере**
  относительно реального контейнера (`ctn.offsetWidth/offsetHeight` не
  пересчитан), что на скролле читается как "дёрганый"/смещённый рендер —
  ровно симптом тестера.
- Отсутствие `webglcontextlost` handler в Aurora означает: если WebKit
  всё-таки убивает контекст (см. Гипотезу A), Aurora **не восстанавливается**
  и просто остаётся пустым до полного remount компонента — то есть карточка
  "не отображается" до навигации туда-обратно.

---

## 4. Гипотеза C (нашли похожий случай, НЕ подтверждена в нашем коде — но стоит держать в уме)

- CSS `backdrop-blur` **над** живым canvas на Safari — известный источник
  рассинхрона композитинга (blur "отваливается"/мигает при скролле или
  transition), особенно в сочетании с `overflow: hidden` + `border-radius`
  на родителе:
  - https://gist.github.com/domske/b66047671c780a238b51c51ffde8d3a0 — гайд
    именно про баг iOS Safari `border-radius` + `overflow: hidden`.
  - https://stackoverflow.com/questions/79391094/backdrop-filter-blur-not-rendering-properly-on-safari
  - https://stackoverflow.com/a/79228571 — backdrop-filter на элементе с
    анимацией внутри аномально дорогой (пересчитывается каждый кадр).
- В нашем коде `backdrop-blur-md`/`backdrop-blur-sm` используется НЕ на самом
  канвасе, а на соседних чипах статуса/traffic-bar внутри той же карточки
  (`subscription-card.tsx`) — они лежат в том же `overflow-hidden
  rounded-card` контейнере, что и WebGL-канвас. Возможный, но не первичный
  фактор — рекомендация ниже (п. 6.4) достаточно дешёвая, чтобы применить
  профилактически, но приоритет ниже гипотез A/B.

## 5. Что проверили и ИСКЛЮЧИЛИ

- **Это не повтор бага v0.9.5.35** (сломанный `#version 300 es` макрос
  `COLOR_RAMP`) — тот фикс уже стоит в текущем `aurora.tsx` (инлайновая
  `colorRamp3()` функция, без multi-line `#define`), подтверждено чтением
  файла и git-историей.
- **Не CSP** — `helmet` CSP в `reiwa/src/api/app.ts` не блокирует `blob:`/`data:`
  для WebGL (WebGL не идёт через `script-src`, это Canvas API).
- **Не Lockdown Mode** — блокирует WebAssembly/JIT, но не сам WebGL2 canvas
  API; и это редкая опциональная настройка, не дефолт.
- **Low Power Mode** — реальный, но вторичный фактор: iOS дросселирует
  `requestAnimationFrame` вплоть до 30fps в Low Power Mode
  (https://motion.dev/magazine/when-browsers-throttle-requestanimationframe),
  что объясняет часть "дёрганости", но НЕ объясняет "карточки не
  отображаются" — это не полное объяснение, только усугубляющий фактор.

---

## 6. Рекомендации к фиксу (без изменения дизайна/фичи, только надёжность)

1. **Единый governor контекстов везде, не только в carousel.** Поднять
   максимум одновременно смонтированных живых WebGL-эффектов до 1 (или явно
   ограниченного малого числа, напр. 2) на ВСЕХ экранах со списком карточек:
   `/plans` (`tariff-card.tsx`), `subscription-select-card.tsx` (продление,
   апгрейд, допокупки). Технически — поднять `active`-паттерн carousel в
   общий хук/контекст (напр. "только карточка в фокусе видимости получает
   `active=true`, остальные показывают статический градиент без WebGL").
2. **Портировать в `Aurora.tsx` уже существующий в проекте надёжный паттерн**
   (Plasma/Grainient): `ResizeObserver` вместо `window.resize`,
   `webglcontextlost`/`webglcontextrestored` с корректным rAF cancel/restart,
   dpr cap (`Math.min(devicePixelRatio, 2)`) — все три уже написаны и
   протестированы в этом же репозитории, это перенос паттерна, не изобретение
   нового.
3. **`try/catch` вокруг `new Renderer()`** в Aurora (Plasma уже это делает) —
   чтобы при отказе WebGL2 (лимит контекстов, отсутствие поддержки) компонент
   тихо ничего не рисовал вместо неявного сбоя, который сейчас ловит только
   внешний `EffectErrorBoundary` (а тот перехватывает лишь синхронные ошибки
   рендера React, не асинхронные WebGL-события).
4. (Низкий приоритет / профилактика) Проверить, не усугубляет ли
   `backdrop-blur-md`/`backdrop-blur-sm` на статус-чипе/traffic-bar рендер
   именно на iOS — при необходимости заменить на непрозрачный `bg-black/60`
   без blur на этих маленьких чипах (визуально почти неотличимо, полностью
   снимает риск п. 4 гипотезы C).

## 7. Что НЕ рекомендуется

- Полный отказ от WebGL-эффектов на iOS (например, принудительный статический
  градиент по User-Agent) — избыточно, ломает фичу для большинства
  пользователей; гипотезы A/B объясняют баг точечными, дешёвыми фиксами без
  потери функциональности.
- Апгрейд/замена библиотеки `ogl` — сама библиотека не является причиной
  (остальные компоненты на ней же уже работают надёжно с правильным
  паттерном), причина — в конкретной реализации `Aurora.tsx` и в отсутствии
  общего governor'а контекстов вне carousel.

---

## Источники (проверено, ссылки актуальны на момент исследования)

- WebGL context limit / "oldest context lost": https://stackoverflow.com/questions/59140439/allowing-more-webgl-contexts , https://stackoverflow.com/questions/52464621/there-are-too-many-active-webgl-contexts-on-this-page-the-oldest-context-will-be-lost
- iOS-specific WebGL canvas quirks: https://developer.apple.com/forums/thread/668999 , https://stackoverflow.com/questions/79847768/webgl-context-immediately-lost-on-ios
- iOS phantom/missing resize events on scroll (address bar): https://stackoverflow.com/questions/18137690/mobile-browsers-dont-fire-up-resize-event-when-hiding-address-bar , https://dad-union.com/en/iphone-safari-scroll-resize-event-problem , https://johnkavanagh.co.uk/articles/understanding-phantom-window-resize-events-in-ios
- iOS rAF throttling in Low Power Mode: https://motion.dev/magazine/when-browsers-throttle-requestanimationframe
- backdrop-filter + canvas/border-radius/overflow Safari quirks: https://gist.github.com/domske/b66047671c780a238b51c51ffde8d3a0 , https://stackoverflow.com/questions/79391094/backdrop-filter-blur-not-rendering-properly-on-safari , https://stackoverflow.com/a/79228571
- Наш предыдущий связанный фикс (другой механизм, тот же симптом-класс, Mini App only): commit `d4017ed`, tag `v0.9.5.35`.
