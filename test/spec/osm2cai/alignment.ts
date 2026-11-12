import { alignmentStatus, latestOsmTimestamp, modifiedElementsSince, validationDateKind } from '../../../modules/osm2cai/alignment';
import type { OsmFullResponse } from '../../../modules/osm2cai/types';

describe('OSM2CAI alignment', () => {
    it('compares SDA 4 validation date with the newest OSM timestamp', () => {
        const properties = { sda: 4, validation_date: '2026-05-02' };
        expect(alignmentStatus(properties, '2026-05-01T10:00:00Z')).toEqual({ kind: 'ok', label: 'aggiornato' });
        expect(alignmentStatus(properties, '2026-05-03T10:00:00Z')).toEqual({ kind: 'error', label: 'da verificare' });
    });

    it('marks invalid, future, recent, and aging validation dates', () => {
        const now = new Date(2026, 10, 6);
        expect(validationDateKind('2026-02-30', now)).toBe('gray');
        expect(validationDateKind('2026-12-01', now)).toBe('gray');
        expect(validationDateKind('2026-01-01', now)).toBe('ok');
        expect(validationDateKind('2025-01-01', now)).toBe('warning');
        expect(validationDateKind('2023-01-01', now)).toBe('error');
    });

    it('returns modified elements after a validation day in relation-way-node order', () => {
        const full: OsmFullResponse = {
            elements: [
                { type: 'node', id: 1, timestamp: '2026-05-04T10:00:00Z' },
                { type: 'way', id: 2, timestamp: '2026-05-03T10:00:00Z' },
                { type: 'relation', id: 3, timestamp: '2026-05-02T10:00:00Z' },
                { type: 'way', id: 4, timestamp: '2026-05-01T10:00:00Z' },
            ],
        };
        expect(modifiedElementsSince(full, '2026-05-01').map(item => item.id)).toEqual([3, 2, 1]);
        expect(latestOsmTimestamp({
            elements: [
                { type: 'relation', id: 3, timestamp: '2026-05-01T10:00:00Z' },
                { type: 'way', id: 4, timestamp: '2026-05-02T10:00:00Z' },
            ],
        }, '3')).toBe('2026-05-02T10:00:00.000Z');
    });
});