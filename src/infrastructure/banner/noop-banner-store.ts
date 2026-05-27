/**
 * Placeholder `BannerStorePort` implementation.
 *
 * Returns `null` for every name/locale pair. Replaced in Wave 6 by a
 * real store that walks DB overrides + filesystem assets. Used during
 * Waves 1B–5 so DI wiring can land before the real assets folder ships.
 */
import type {
  BannerResource,
  BannerStorePort,
} from '../../application/ports/banner-store.port.js';
import type { BannerName } from '../../core/enums/banner-name.enum.js';
import type { SupportedLocale } from '../../core/enums/locale.enum.js';

export class NoopBannerStore implements BannerStorePort {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async resolve(_name: BannerName, _lang: SupportedLocale): Promise<BannerResource | null> {
    return null;
  }
}
