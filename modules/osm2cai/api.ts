import type { Osm2CaiResponse, OsmApiElement, OsmFullResponse } from './types';

const OSM_API = 'https://api.openstreetmap.org/api/0.6';
const OSM2CAI_API = 'https://osm2cai.cai.it/api/v2/hiking-route-osm';
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_RELATIONS = 36;
const MAX_WAYS = 80;

async function getJson<T>(url: string, expectedOrigin: string, signal: AbortSignal): Promise<T> {
    const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal,
    });
    if (!response.ok || new URL(response.url).origin !== expectedOrigin) {
        throw new Error(`Risposta HTTP non valida (${response.status}).`);
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error('Risposta API troppo grande.');
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Formato JSON API non valido.');
    }
    return data as T;
}

function elementKey(element: OsmApiElement) {
    return `${element.type}:${element.id}`;
}

function nestedRelationIds(elements: Map<string, OsmApiElement>, rootId: string) {
    const result = new Set<string>();
    const visited = new Set<string>();
    function collect(id: string, depth: number) {
        if (depth > 12 || visited.has(id)) return;
        visited.add(id);
        const relation = elements.get(`relation:${id}`);
        for (const member of relation?.members || []) {
            if (member.type !== 'relation') continue;
            const nestedId = String(member.ref);
            result.add(nestedId);
            collect(nestedId, depth + 1);
        }
    }
    collect(rootId, 0);
    return result;
}

function mergeElements(target: Map<string, OsmApiElement>, response: OsmFullResponse) {
    for (const element of response.elements || []) {
        const key = elementKey(element);
        const existing = target.get(key);
        if (existing?.type === 'way' && (existing.nodes?.length || 0) >= 2 &&
            (!Array.isArray(element.nodes) || element.nodes.length < 2)) continue;
        target.set(key, element);
    }
}

async function fetchOsmFull(relationId: string, signal: AbortSignal): Promise<OsmFullResponse> {
    const elements = new Map<string, OsmApiElement>();
    const fetchedRelations = new Set([relationId]);
    const root = await getJson<OsmFullResponse>(
        `${OSM_API}/relation/${encodeURIComponent(relationId)}/full.json`,
        'https://api.openstreetmap.org', signal
    );
    mergeElements(elements, root);

    for (let pass = 0; pass < 12 && !signal.aborted; pass++) {
        const todo = [...nestedRelationIds(elements, relationId)]
            .filter(id => /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id)) && !fetchedRelations.has(id))
            .slice(0, MAX_RELATIONS - fetchedRelations.size);
        if (!todo.length) break;
        todo.forEach(id => fetchedRelations.add(id));
        const results = await Promise.all(todo.map(id => getJson<OsmFullResponse>(
            `${OSM_API}/relation/${encodeURIComponent(id)}/full.json`,
            'https://api.openstreetmap.org', signal
        )));
        results.forEach(result => mergeElements(elements, result));
    }
    if (signal.aborted) throw new DOMException('Richiesta annullata.', 'AbortError');

    const allElements = [...elements.values()];
    const ways = new Map(allElements.filter(element => element.type === 'way').map(element => [String(element.id), element]));
    const relation = elements.get(`relation:${relationId}`);
    const reachable = nestedRelationIds(elements, relationId);
    const relations = new Set([relationId, ...reachable]);
    const missingWayIds = new Set<string>();
    for (const id of relations) {
        for (const member of elements.get(`relation:${id}`)?.members || []) {
            if (member.type !== 'way') continue;
            const wayId = String(member.ref);
            const way = ways.get(wayId);
            if (!Array.isArray(way?.nodes) || way.nodes.length < 2) missingWayIds.add(wayId);
        }
    }

    const todoWays = [...missingWayIds]
        .filter(id => /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id)))
        .slice(0, MAX_WAYS);
    for (let offset = 0; offset < todoWays.length && !signal.aborted; offset += 8) {
        const batch = todoWays.slice(offset, offset + 8);
        const results = await Promise.all(batch.map(id => getJson<OsmFullResponse>(
            `${OSM_API}/way/${encodeURIComponent(id)}/full.json`,
            'https://api.openstreetmap.org', signal
        )));
        results.forEach(result => mergeElements(elements, result));
    }
    if (signal.aborted) throw new DOMException('Richiesta annullata.', 'AbortError');
    if (!relation) throw new Error('Relazione non trovata nei dati OSM.');
    return { elements: [...elements.values()] };
}

export interface RouteData {
    osm: OsmFullResponse | null;
    osmError: string | null;
    osm2cai: Osm2CaiResponse | null;
    osm2caiError: string | null;
}

export async function loadRouteData(relationId: string, signal: AbortSignal): Promise<RouteData> {
    if (!/^[1-9]\d{0,15}$/.test(relationId) || !Number.isSafeInteger(Number(relationId))) {
        throw new Error('Identificativo relazione non valido.');
    }
    const osmRequest = fetchOsmFull(relationId, signal);
    const caiRequest = getJson<Osm2CaiResponse>(
        `${OSM2CAI_API}/${encodeURIComponent(relationId)}`,
        'https://osm2cai.cai.it', signal
    );
    const [osmResult, caiResult] = await Promise.allSettled([osmRequest, caiRequest]);
    if (signal.aborted) throw new DOMException('Richiesta annullata.', 'AbortError');
    return {
        osm: osmResult.status === 'fulfilled' ? osmResult.value : null,
        osmError: osmResult.status === 'rejected' ? 'Dati OSM non disponibili.' : null,
        osm2cai: caiResult.status === 'fulfilled' ? caiResult.value : null,
        osm2caiError: caiResult.status === 'rejected' ? 'Servizio OSM2CAI non disponibile.' : null,
    };
}