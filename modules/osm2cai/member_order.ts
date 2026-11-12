import type { RelationMember } from '../osm/relation';
import type { OsmApiElement, OsmFullResponse } from './types';

export interface OrderedWay {
    id: string;
    index: number;
}

export interface OrderIssue {
    nodeId: string;
    kind: 'disconnected' | 'branch';
    label: string;
}

export interface MemberOrderResult {
    error?: string;
    incomplete?: boolean;
    total?: number;
    breaks?: number;
    continuous?: boolean;
    repeated?: number;
    branches?: number;
    connected?: boolean;
    ends?: number;
    ring?: boolean;
    topology?: 'disconnected' | 'branching' | 'ring' | 'linear' | 'complex';
    roleSensitive?: boolean;
    nestedRelations?: number;
    proposal?: OrderedWay[] | null;
    changes?: number;
    nonWays?: number;
    issues?: OrderIssue[];
}

interface RelationGeometry {
    members: Array<{ ref: number | string; role?: string }>;
    nested: number;
    missing: string[];
    cycles: string[];
}

function relationGeometryMembers(full: OsmFullResponse, relationId: string): RelationGeometry {
    const elements = full.elements || [];
    const relations = new Map(elements.filter(item => item.type === 'relation').map(item => [String(item.id), item]));
    const members: RelationGeometry['members'] = [];
    const missing = new Set<string>();
    const cycles = new Set<string>();
    let nested = 0;

    function visit(id: string, ancestors: Set<string>, depth: number) {
        if (ancestors.has(id)) {
            cycles.add(id);
            return;
        }
        if (depth > 12) {
            missing.add(id);
            return;
        }
        const relation = relations.get(id);
        if (!relation || !Array.isArray(relation.members)) {
            missing.add(id);
            return;
        }
        const next = new Set(ancestors).add(id);
        for (const member of relation.members) {
            if (member.type === 'way') members.push(member);
            else if (member.type === 'relation') {
                nested++;
                visit(String(member.ref), next, depth + 1);
            }
        }
    }

    visit(relationId, new Set(), 0);
    return { members, nested, missing: [...missing], cycles: [...cycles] };
}

function issuePoints(
    elements: OsmApiElement[],
    edges: Array<{ id: string; a: string; b: string }>,
    adjacency: Map<string, number[]>
): OrderIssue[] {
    const nodes = new Map(elements.filter(item => item.type === 'node').map(item => [String(item.id), item]));
    const issues: OrderIssue[] = [];
    const add = (nodeId: string, kind: OrderIssue['kind'], label: string) => {
        const node = nodes.get(nodeId);
        if (Number.isFinite(node?.lat) && Number.isFinite(node?.lon)) {
            issues.push({ nodeId, kind, label });
        }
    };
    const components: string[][] = [];
    const visited = new Set<string>();

    for (const root of adjacency.keys()) {
        if (visited.has(root)) continue;
        const group: string[] = [];
        const stack = [root];
        while (stack.length) {
            const nodeId = stack.pop()!;
            if (visited.has(nodeId)) continue;
            visited.add(nodeId);
            group.push(nodeId);
            for (const edgeIndex of adjacency.get(nodeId) || []) {
                stack.push(edges[edgeIndex].a, edges[edgeIndex].b);
            }
        }
        components.push(group);
    }

    if (components.length > 1) {
        components.forEach((group, index) => {
            const ends = group.filter(nodeId => (adjacency.get(nodeId) || []).length === 1);
            (ends.length ? ends : group.slice(0, 1)).forEach(nodeId =>
                add(nodeId, 'disconnected', `Componente ${index + 1}`)
            );
        });
    }
    for (const [nodeId, edgeIndexes] of adjacency) {
        if (edgeIndexes.length > 2) add(nodeId, 'branch', `Biforcazione (${edgeIndexes.length} way)`);
    }
    return issues;
}

function proposeWayOrder(
    edges: Array<{ id: string; a: string; b: string; index: number; role: string }>,
    adjacency: Map<string, number[]>,
    linear: boolean,
    ring: boolean
): OrderedWay[] | null {
    const first = edges[0];
    const starts = linear
        ? [(adjacency.get(first.a) || []).length === 1 ? first.a
            : (adjacency.get(first.b) || []).length === 1 ? first.b
                : first.a]
        : [first.a, first.b];
    for (const start of new Set(starts)) {
        const used = new Set<number>();
        const result: OrderedWay[] = [];
        let cursor = start;
        while (result.length < edges.length) {
            const available = (adjacency.get(cursor) || []).filter(index => !used.has(index));
            if (!available.length) break;
            const index = result.length === 0
                ? (available.includes(first.index) ? first.index : available[0])
                : available[0];
            const edge = edges[index];
            if (edge.a !== cursor && edge.b !== cursor) break;
            used.add(index);
            result.push({ id: edge.id, index: edge.index });
            cursor = edge.a === cursor ? edge.b : edge.a;
        }
        if (result.length === edges.length && (!ring || cursor === start)) return result;
    }
    return null;
}

export function analyzeMemberOrder(full: OsmFullResponse, relationId: string): MemberOrderResult {
    const elements = full.elements || [];
    const relation = elements.find(item => item.type === 'relation' && String(item.id) === relationId);
    if (!relation || !Array.isArray(relation.members)) {
        return { error: 'Relazione non disponibile nei dati OSM.' };
    }

    const geometry = relationGeometryMembers(full, relationId);
    const members = geometry.members;
    if (geometry.missing.length || geometry.cycles.length) {
        return {
            error: `Analisi incompleta: sottorelazioni non disponibili o circolari (${[...geometry.missing, ...geometry.cycles].join(', ')}).`,
            incomplete: true,
        };
    }
    if (!members.length) return { error: 'La relazione e le sottorelazioni non contengono way.' };

    const ways = new Map(elements.filter(item => item.type === 'way').map(item => [String(item.id), item]));
    const edges: Array<{ id: string; a: string; b: string; index: number; role: string }> = [];
    for (const [index, member] of members.entries()) {
        const way = ways.get(String(member.ref));
        if (!way || !Array.isArray(way.nodes) || way.nodes.length < 2) {
            return {
                error: `Geometria della way ${member.ref} non disponibile. Analisi incompleta: riprova.`,
                incomplete: true,
            };
        }
        edges.push({
            id: String(member.ref),
            a: String(way.nodes[0]),
            b: String(way.nodes[way.nodes.length - 1]),
            index,
            role: member.role || '',
        });
    }

    const adjacency = new Map<string, number[]>();
    for (const [index, edge] of edges.entries()) {
        for (const nodeId of [edge.a, edge.b]) {
            if (!adjacency.has(nodeId)) adjacency.set(nodeId, []);
            adjacency.get(nodeId)!.push(index);
        }
    }
    const repeated = edges.length - new Set(edges.map(edge => edge.id)).size;
    const branches = [...adjacency.values()].filter(items => items.length > 2).length;
    const ends = [...adjacency.values()].filter(items => items.length === 1).length;
    const visited = new Set<string>();
    const stack = [edges[0].a];
    while (stack.length) {
        const nodeId = stack.pop()!;
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);
        for (const index of adjacency.get(nodeId) || []) {
            const edge = edges[index];
            stack.push(edge.a === nodeId ? edge.b : edge.a);
        }
    }
    const connected = visited.size === adjacency.size;
    const ring = connected && ends === 0 && branches === 0;
    const linear = connected && ends === 2 && branches === 0;
    const topology = !connected ? 'disconnected' : branches ? 'branching'
        : ring ? 'ring' : linear ? 'linear' : 'complex';
    const roleSensitive = edges.some(edge => edge.role.trim() !== '');

    function traverseCurrent(start: string) {
        let cursor = start;
        let breaks = 0;
        for (const edge of edges) {
            if (edge.a === cursor) cursor = edge.b;
            else if (edge.b === cursor) cursor = edge.a;
            else {
                breaks++;
                cursor = edge.b;
            }
        }
        return breaks;
    }
    const breaks = Math.min(traverseCurrent(edges[0].a), traverseCurrent(edges[0].b));
    const continuous = breaks === 0;
    const proposal = !repeated && !roleSensitive && !geometry.nested && (linear || ring)
        ? proposeWayOrder(edges, adjacency, linear, ring)
        : null;

    return {
        total: edges.length,
        breaks,
        continuous,
        repeated,
        branches,
        connected,
        ends,
        ring,
        topology,
        roleSensitive,
        nestedRelations: geometry.nested,
        proposal,
        changes: proposal ? proposal.filter((edge, index) => edge.index !== index).length : 0,
        nonWays: relation.members.filter(member => member.type !== 'way').length,
        issues: issuePoints(elements, edges, adjacency),
    };
}

export function reorderWayMembers(
    members: RelationMember[],
    order: number[]
): RelationMember[] | null {
    const ways = members.filter(member => member.type === 'way');
    if (order.length !== ways.length || new Set(order).size !== ways.length ||
        order.some(index => !Number.isInteger(index) || index < 0 || index >= ways.length)) {
        return null;
    }
    const reordered = order.map(index => ways[index]);
    let wayIndex = 0;
    return members.map(member => member.type === 'way' ? reordered[wayIndex++] : member);
}