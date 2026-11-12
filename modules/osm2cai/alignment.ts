import type { OsmApiElement, Osm2CaiProperties, OsmFullResponse } from './types';

export type AlignmentKind = 'ok' | 'warning' | 'error' | 'gray';

export interface AlignmentStatus {
    kind: AlignmentKind;
    label: string;
}

export function latestOsmTimestamp(full: OsmFullResponse, relationId: string): string | null {
    const elements = full.elements;
    if (!Array.isArray(elements) || !elements.some(item =>
        item.type === 'relation' && String(item.id) === relationId
    )) return null;
    let latest = -Infinity;
    for (const item of elements) {
        const timestamp = typeof item.timestamp === 'string' ? Date.parse(item.timestamp) : NaN;
        if (!Number.isFinite(timestamp)) return null;
        latest = Math.max(latest, timestamp);
    }
    return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
}

export function validationDateKind(value: unknown, now = new Date()): AlignmentKind {
    if (typeof value !== 'string') return 'gray';
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
    if (!match) return 'gray';
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return 'gray';
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (date > today) return 'gray';
    const monthsAgo = (count: number) => {
        const threshold = new Date(today.getFullYear(), today.getMonth() - count, 1);
        const lastDay = new Date(threshold.getFullYear(), threshold.getMonth() + 1, 0).getDate();
        threshold.setDate(Math.min(today.getDate(), lastDay));
        return threshold;
    };
    if (date >= monthsAgo(12)) return 'ok';
    if (date >= monthsAgo(24)) return 'warning';
    return 'error';
}

export function alignmentStatus(properties: Osm2CaiProperties | undefined, osmTimestamp: string | null): AlignmentStatus {
    const sda = String(properties?.sda ?? '').trim();
    const source = sda === '4' ? properties?.validation_date
        : ['1', '2', '3'].includes(sda) ? properties?.updated_at : undefined;
    const osmTime = osmTimestamp ? Date.parse(osmTimestamp) : NaN;
    if (!Number.isFinite(osmTime) || typeof source !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}(?:$|T|\s)/.test(source.trim())) {
        return { kind: 'gray', label: 'non verificabile' };
    }
    const stamp = source.trim();
    const sourceTime = Date.parse(stamp);
    if (!Number.isFinite(sourceTime)) return { kind: 'gray', label: 'non verificabile' };
    const aligned = /^\d{4}-\d{2}-\d{2}$/.test(stamp)
        ? stamp >= osmTimestamp!.slice(0, 10)
        : sourceTime >= osmTime;
    return aligned
        ? { kind: 'ok', label: 'aggiornato' }
        : { kind: 'error', label: sda === '4' ? 'da verificare' : 'da aggiornare' };
}

export function modifiedElementsSince(full: OsmFullResponse, validationDate: unknown): OsmApiElement[] {
    const elements = full.elements;
    if (!Array.isArray(elements) || typeof validationDate !== 'string') return [];
    const stamp = validationDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}(?:$|T|\s)/.test(stamp)) return [];
    const validationTime = Date.parse(stamp);
    if (!Number.isFinite(validationTime)) return [];
    const onlyDay = /^\d{4}-\d{2}-\d{2}$/.test(stamp);
    const order: Record<string, number> = { relation: 0, way: 1, node: 2 };
    return elements.filter(item => {
        const modified = typeof item.timestamp === 'string' ? Date.parse(item.timestamp) : NaN;
        return Number.isFinite(modified) && (onlyDay
            ? item.timestamp!.slice(0, 10) > stamp
            : modified > validationTime);
    }).sort((a, b) => {
        const group = (order[a.type] ?? 3) - (order[b.type] ?? 3);
        return group || Date.parse(b.timestamp || '') - Date.parse(a.timestamp || '');
    });
}