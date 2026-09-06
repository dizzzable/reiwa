/**
 * The servers screen — a planet, and the places behind this subscription.
 *
 * Opened by double-tapping a subscription card. What it shows is deliberately
 * limited to what a customer can act on: which places their traffic can leave
 * from, whether each is up, how long it has been up, and which one to pick now.
 * Addresses, node names and IPs are not withheld here — they never leave the
 * panel; see `SubscriberServerInterface` upstream.
 *
 * THE PLANET HAS NO FRAME. It sits directly on the blurred subscription page,
 * with no card, border or panel around it, because the operator asked for it to
 * hang in the air. That is why the backdrop is a blur of what was already on
 * screen rather than a colour: the globe reads as floating over the page the
 * customer just left, not as a picture pasted on top of it.
 *
 * IT ARRIVES IN ORDER. The gesture is a double tap and what it was for is the
 * planet, so the planet leads: the blurred page, the title, then the planet
 * growing into place, then the recommendation, then the list one row behind
 * another. The timings are all in `servers-sheet-motion.ts` rather than spread
 * across `delay:` props here, because the sequence is the design and a sequence
 * has to be readable in one place. Under `prefers-reduced-motion` none of it
 * runs and the screen is simply there.
 *
 * MARKERS ARE NOT GUARANTEED. Only the `globe` variant draws real geography, so
 * only it can point at anywhere; and even there a server may have no point —
 * a load balancer flagged 🇪🇺 decodes to a country code that is not a country.
 * Such a server is listed like any other and simply is not drawn on the planet,
 * because a balancer is a choice between places rather than a place.
 */
import { lazy, Suspense, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { X } from 'lucide-react';

import { getSubscriptionServers } from '@/lib/api-client/servers';
import type { SubscriberServer } from '@/lib/api-client/servers';
import { cn } from '@/lib/utils';

import { countryPoint } from './country-points';
import { rowDelay, SERVERS_SHEET_MOTION } from './servers-sheet-motion';
import './servers-sheet-motion.css';
import {
  GLOBE_CATALOG,
  type GlobePreferences,
} from '@/components/reactbits/originkit/globe-preferences';

/**
 * All three planets are split out of the main bundle.
 *
 * Each drags `three` (and, for `globe`, `d3-geo` and the baked land) behind it,
 * and none of that has any business loading for a customer who never performs
 * the gesture.
 */
const Globe = lazy(() => import('@/components/reactbits/originkit/Globe'));
const GlobeMesh = lazy(() => import('@/components/reactbits/originkit/GlobeMesh'));
const DitherGlobe = lazy(() => import('@/components/reactbits/originkit/DitherGlobe'));

export interface ServersSheetProps {
  readonly subscriptionId: string;
  readonly preferences: GlobePreferences;
  readonly onClose: () => void;
}

export function ServersSheet({
  subscriptionId,
  preferences,
  onClose,
}: ServersSheetProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();

  const { data, isPending } = useQuery({
    queryKey: ['subscription-servers', subscriptionId],
    queryFn: () => getSubscriptionServers(subscriptionId),
    // The panel already caches the panel-wide snapshot for twenty seconds;
    // matching it here keeps a reopened sheet instant without ever showing
    // state older than the panel would have served anyway.
    staleTime: 20_000,
  });

  const servers = data?.servers ?? [];
  const recommended = useMemo(
    () => servers.find((server) => server.id === data?.recommendedServerId) ?? null,
    [data?.recommendedServerId, servers],
  );

  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Escape closes it, as with every other overlay in the cabinet.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * The three things a bare `position: fixed` div does not do for itself.
   *
   * `media-viewer` states the house rule in as many words — it is built on the
   * Radix dialog primitive rather than a bare fixed div precisely so the focus
   * trap, Escape, the scroll lock and the portal come for free. This screen is
   * simpler than that one and does not need a portal, but it does need these:
   *
   *  - the page behind kept scrolling under the sheet, and on iOS an overscroll
   *    at either end of the list chained straight through to the dashboard;
   *  - opening moved focus nowhere, so a screen-reader user stayed on the card;
   *  - closing left focus on a removed node, which falls back to `<body>` and
   *    loses the reader's place entirely.
   */
  useEffect(() => {
    const returnTo = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const previousOverscroll = document.body.style.overscrollBehavior;
    document.body.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'contain';
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.overscrollBehavior = previousOverscroll;
      if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus();
    };
  }, []);

  return (
    <motion.div
      className="fixed inset-0 z-50 overflow-y-auto overscroll-contain"
      initial={reducedMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={reducedMotion ? undefined : { opacity: 0 }}
      transition={{ duration: SERVERS_SHEET_MOTION.backdrop.duration }}
      role="dialog"
      aria-modal="true"
      aria-label={t('servers.title')}
      style={{
        // The page underneath, blurred — not a colour. The globe has no frame,
        // so this is what places it in front of where the customer just was.
        backdropFilter: 'blur(22px)',
        WebkitBackdropFilter: 'blur(22px)',
        backgroundColor: 'rgb(7 7 10 / 0.62)',
      }}
    >
      {/* BLOCK FLOW, DELIBERATELY, and the width of the cabinet's own shell.
          This was `flex flex-col` on the scroller above, and with a definite
          height (`inset-0`) flex shrank these children to fit rather than
          letting the container scroll. The globe wrapper asks for
          `min(46vh, 360px)` and holds a child at `height: 100%` -- and a
          percentage height resolves against the SPECIFIED height, not the one
          flex shrank it to. The wrapper collapsed, the rows moved up into the
          space, and the canvas went on drawing its full 360px over the top of
          them. Block boxes do not shrink; the container scrolls instead.

          `max-w-[46rem]` is `stealth-layout`'s column. Without it every row ran
          the full width of a desktop screen. */}
      <div className="mx-auto w-full max-w-[46rem]">
        {/* The inset, not a flat padding: in Telegram fullscreen on a notched
            phone the title and the close button rode under the status bar.
            Every other top-of-screen surface in this cabinet uses it. */}
        <motion.header
          className="flex items-start justify-between gap-3 px-5 pb-2"
          style={{ paddingTop: 'max(1.5rem, env(safe-area-inset-top))' }}
          initial={reducedMotion ? false : { opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={
            reducedMotion
              ? { duration: 0 }
              : {
                  duration: SERVERS_SHEET_MOTION.header.duration,
                  delay: SERVERS_SHEET_MOTION.header.delay,
                }
          }
        >
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-foreground">
              {t('servers.title')}
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              {t('servers.subtitle', { count: servers.length })}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-full p-2 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-5" />
          </button>
        </motion.header>

        <GlobeStage
          servers={servers}
          preferences={preferences}
          reducedMotion={Boolean(reducedMotion)}
        />

        {recommended !== null && (
          <Recommended server={recommended} reducedMotion={Boolean(reducedMotion)} />
        )}

        <section className="px-5 pb-10">
          <h3 className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            {t('servers.listHeading')}
          </h3>
          {isPending ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('servers.loading')}
            </p>
          ) : servers.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('servers.empty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              <AnimatePresence initial={!reducedMotion}>
                {servers.map((server, index) => (
                  <ServerRow
                    key={server.id}
                    server={server}
                    index={index}
                    reducedMotion={Boolean(reducedMotion)}
                  />
                ))}
              </AnimatePresence>
            </ul>
          )}
        </section>
      </div>
    </motion.div>
  );
}

/**
 * The planet itself, with a marker per server that has a place.
 *
 * Sized in viewport units and capped, so it stays a planet rather than a band
 * across a tablet.
 */
function GlobeStage({
  servers,
  preferences,
  reducedMotion,
}: {
  readonly servers: readonly SubscriberServer[];
  readonly preferences: GlobePreferences;
  readonly reducedMotion: boolean;
}) {
  const markers = useMemo(() => {
    if (!GLOBE_CATALOG[preferences.variant].supportsMarkers) return [];
    const placed: { lat: number; lng: number }[] = [];
    for (const server of servers) {
      const point = countryPoint(server.countryCode);
      if (point === null) continue;
      placed.push({ lat: point[0], lng: point[1] });
    }
    return placed;
  }, [preferences.variant, servers]);

  // Read field by field rather than spread. `resolveGlobeProps` guarantees every
  // catalog entry is present and in range, so a spread would typecheck through a
  // cast — and then a prop renamed on either side would go silently missing,
  // leaving a globe that renders with a default nobody chose. Naming them makes
  // that a compile error.
  const p = preferences.props;
  const n = (key: string, fallback: number) =>
    typeof p[key] === 'number' ? (p[key] as number) : fallback;
  const s = (key: string, fallback: string) =>
    typeof p[key] === 'string' ? (p[key] as string) : fallback;
  const b = (key: string, fallback: boolean) =>
    typeof p[key] === 'boolean' ? (p[key] as boolean) : fallback;

  return (
    <motion.div
      // `shrink-0` is belt and braces: this box holds a child at `height: 100%`,
      // and any ancestor that ever shrinks it again would leave the canvas
      // drawing at full size over whatever moved up underneath. The layout
      // above is block flow now, so nothing shrinks it -- this makes the box
      // refuse anyway.
      //
      // `servers-planet` is the hook the canvas reveal hangs on; see
      // `servers-sheet-motion.css`. It carries no appearance of its own.
      className="servers-planet mx-auto w-full shrink-0"
      style={{ height: 'min(46vh, 360px)' }}
      // It grows into place rather than sliding: a sphere that settles reads as
      // an object, one that slides reads as a panel.
      initial={
        reducedMotion
          ? false
          : { opacity: 0, scale: SERVERS_SHEET_MOTION.planet.scaleFrom }
      }
      animate={{ opacity: 1, scale: 1 }}
      transition={
        reducedMotion
          ? { duration: 0 }
          : {
              duration: SERVERS_SHEET_MOTION.planet.duration,
              delay: SERVERS_SHEET_MOTION.planet.delay,
              ease: [0.16, 1, 0.3, 1],
            }
      }
      // Decorative: everything it conveys is also in the list below, and a
      // screen reader has nothing to do with a turning ball.
      aria-hidden="true"
    >
      <Suspense fallback={null}>
        {preferences.variant === 'globe' ? (
          <Globe
            speed={n('speed', 2)}
            smoothing={n('smoothing', 8)}
            scale={n('scale', 8)}
            direction={s('direction', 'left') === 'right' ? 'right' : 'left'}
            stopOnHover={b('stopOnHover', true)}
            initialLatitude={n('initialLatitude', 23)}
            initialLongitude={n('initialLongitude', -23)}
            dragSpeed={n('dragSpeed', 5)}
            detail={n('detail', 5)}
            fill={s('fill', 'dots') === 'solid' ? 'solid' : 'dots'}
            fillColor={s('fillColor', '#FFFFFF')}
            showOutline={b('showOutline', true)}
            outlineColor={s('outlineColor', '#FFFFFF')}
            outlineWidth={n('outlineWidth', 1)}
            showGrid={b('showGrid', true)}
            graticuleColor={s('graticuleColor', '#D4D4D4')}
            oceanColor={s('oceanColor', '#000000')}
            dots={{
              color: s('dotColor', '#FFFFFF'),
              size: n('dotSize', 5),
              density: n('dotDensity', 8),
              allDots: b('allDots', false),
            }}
            markerConfig={{
              markers,
              color: s('markerColor', '#00F7FF'),
              size: n('markerSize', 40),
            }}
          />
        ) : preferences.variant === 'globe-mesh' ? (
          <GlobeMesh
            dot={s('dot', '#FFFFFF')}
            net={s('net', '#26FF00')}
            density={n('density', 20)}
            spin={n('spin', 20)}
            spinDir={s('spinDir', 'right') === 'left' ? 'left' : 'right'}
            hoverOn={b('hoverOn', true)}
            sizePercent={n('sizePercent', 100)}
          />
        ) : (
          <DitherGlobe
            colorA={s('colorA', '#0B0B12')}
            colorB={s('colorB', '#E8E8F0')}
            accent={s('accent', '#5B8DEF')}
            pixel={n('pixel', 4)}
            levels={n('levels', 6)}
            land={n('land', 50)}
            globeSize={n('globeSize', 100)}
            glowEnabled={b('glowEnabled', true)}
            glowSize={n('glowSize', 12)}
            speed={n('speed', 6)}
            dragEnabled={b('dragEnabled', true)}
          />
        )}
      </Suspense>
    </motion.div>
  );
}

/** The one to use right now, and why. */
function Recommended({
  server,
  reducedMotion,
}: {
  readonly server: SubscriberServer;
  readonly reducedMotion: boolean;
}) {
  const { t } = useTranslation();
  return (
    <motion.div
      className="mx-5 mb-4 flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5"
      initial={reducedMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        reducedMotion
          ? { duration: 0 }
          : {
              duration: SERVERS_SHEET_MOTION.recommended.duration,
              delay: SERVERS_SHEET_MOTION.recommended.delay,
            }
      }
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-emerald-500/15 text-base">
        {server.flag ?? '🛰'}
      </span>
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-emerald-400">
          {t('servers.recommendedLabel')}
        </p>
        <p className="truncate text-sm font-semibold text-foreground">{server.name}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {t('servers.recommendedWhy')}
        </p>
      </div>
    </motion.div>
  );
}

const STATUS_DOT: Record<SubscriberServer['status'], string> = {
  online: 'bg-emerald-400',
  connecting: 'bg-amber-400',
  offline: 'bg-rose-400',
  unknown: 'bg-zinc-500',
};

function ServerRow({
  server,
  index,
  reducedMotion,
}: {
  readonly server: SubscriberServer;
  readonly index: number;
  readonly reducedMotion: boolean;
}) {
  const { t } = useTranslation();
  const uptime = formatUptime(server.uptimeSeconds, t);

  return (
    <motion.li
      className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5"
      initial={reducedMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        reducedMotion
          ? { duration: 0 }
          : { duration: SERVERS_SHEET_MOTION.list.duration, delay: rowDelay(index) }
      }
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-base">
        {server.flag ?? '🛰'}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{server.name}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {t(`servers.status.${server.status}`)}
          {uptime !== null ? ` · ${uptime}` : ''}
        </p>
      </div>
      <span
        className={cn('size-2 shrink-0 rounded-full', STATUS_DOT[server.status])}
        aria-hidden="true"
      />
    </motion.li>
  );
}

/**
 * "In service for N" — never "N% available".
 *
 * The number is how long a process has been running, which is a different
 * claim: a node restarted five minutes ago is working perfectly and reads five
 * minutes. Wording that implied availability would be false.
 */
function formatUptime(
  seconds: number | null,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) return t('servers.uptimeDays', { count: days });
  const hours = Math.floor(seconds / 3_600);
  if (hours >= 1) return t('servers.uptimeHours', { count: hours });
  return t('servers.uptimeMinutes', { count: Math.max(1, Math.floor(seconds / 60)) });
}
