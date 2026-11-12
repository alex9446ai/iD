import { loadRouteData } from '../../../modules/osm2cai/api';

describe('OSM2CAI API loading', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('keeps OSM2CAI data when the OSM API is unavailable', async () => {
        vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('api.openstreetmap.org')) return Promise.reject(new Error('offline'));
            return Promise.resolve({
                ok: true,
                status: 200,
                url,
                text: () => Promise.resolve(JSON.stringify({ properties: { sda: '4' } })),
            });
        }));

        const result = await loadRouteData('123', new AbortController().signal);
        expect(result.osm).toBeNull();
        expect(result.osmError).toBe('Dati OSM non disponibili.');
        expect(result.osm2cai?.properties?.sda).toBe('4');
        expect(result.osm2caiError).toBeNull();
    });
});