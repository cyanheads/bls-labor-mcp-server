/**
 * @fileoverview Tests for the two service shutdown paths wired to
 * `createApp({ teardown })` — the catalog index and the observations mirror.
 * The framework's SQLite store and mirror are stubbed so the assertions land on
 * this server's own teardown wiring: delegation to `close()`, the cleared
 * accessor, and the no-op when the mirror is switched off.
 * @module tests/services/service-shutdown.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { catalogStoreClose, mirrorClose } = vi.hoisted(() => ({
  catalogStoreClose: vi.fn(async () => {}),
  mirrorClose: vi.fn(async () => {}),
}));

vi.mock('@cyanheads/mcp-ts-core/mirror', () => ({
  sqliteMirrorStore: () => ({ close: catalogStoreClose }),
  defineMirror: () => ({ close: mirrorClose }),
}));

import { resetServerConfig } from '@/config/server-config.js';
import {
  getBlsCatalogService,
  initBlsCatalogService,
  shutdownBlsCatalogService,
} from '@/services/bls-catalog/bls-catalog-service.js';
import {
  initBlsObservationsService,
  isBlsObservationsServiceReady,
  shutdownBlsObservationsService,
} from '@/services/bls-observations/bls-observations-service.js';

/** `initBlsCatalogService` takes the core handles positionally and reads neither. */
const coreConfig = {} as AppConfig;
const coreStorage = {} as StorageService;

beforeEach(() => {
  catalogStoreClose.mockClear();
  mirrorClose.mockClear();
  resetServerConfig();
});

afterEach(async () => {
  await shutdownBlsCatalogService();
  await shutdownBlsObservationsService();
  vi.unstubAllEnvs();
  resetServerConfig();
});

describe('shutdownBlsCatalogService', () => {
  it('closes the catalog index and clears the accessor', async () => {
    initBlsCatalogService(coreConfig, coreStorage);
    expect(getBlsCatalogService()).toBeDefined();

    await shutdownBlsCatalogService();

    expect(catalogStoreClose).toHaveBeenCalledTimes(1);
    expect(() => getBlsCatalogService()).toThrow(/not initialized/);
  });

  it('is a no-op once the service has been released', async () => {
    initBlsCatalogService(coreConfig, coreStorage);
    await shutdownBlsCatalogService();

    await expect(shutdownBlsCatalogService()).resolves.toBeUndefined();
    expect(catalogStoreClose).toHaveBeenCalledTimes(1);
  });
});

describe('shutdownBlsObservationsService', () => {
  it('closes the mirror and clears the accessor when the mirror is enabled', async () => {
    vi.stubEnv('BLS_OBSERVATIONS_MIRROR_ENABLED', 'true');
    resetServerConfig();
    initBlsObservationsService();
    expect(isBlsObservationsServiceReady()).toBe(true);

    await shutdownBlsObservationsService();

    expect(mirrorClose).toHaveBeenCalledTimes(1);
    expect(isBlsObservationsServiceReady()).toBe(false);
  });

  it('resolves without touching a mirror that was never constructed', async () => {
    // The default deployment: setup() skips the mirror, so teardown has nothing
    // to close and must not raise on the way out.
    vi.stubEnv('BLS_OBSERVATIONS_MIRROR_ENABLED', 'false');
    resetServerConfig();
    initBlsObservationsService();
    expect(isBlsObservationsServiceReady()).toBe(false);

    await expect(shutdownBlsObservationsService()).resolves.toBeUndefined();
    expect(mirrorClose).not.toHaveBeenCalled();
  });
});
