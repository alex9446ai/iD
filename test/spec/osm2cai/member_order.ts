import { analyzeMemberOrder, reorderWayMembers } from '../../../modules/osm2cai/member_order';
import type { RelationMember } from '../../../modules/osm/relation';
import type { OsmFullResponse } from '../../../modules/osm2cai/types';

describe('OSM2CAI member order analysis', () => {
    it('proposes a continuous sequence for a scrambled linear route', () => {
        const full: OsmFullResponse = {
            elements: [
                { type: 'relation', id: 1, members: [
                    { type: 'way', ref: 10 }, { type: 'way', ref: 12 }, { type: 'way', ref: 11 },
                ] },
                { type: 'way', id: 10, nodes: [1, 2] },
                { type: 'way', id: 11, nodes: [2, 3] },
                { type: 'way', id: 12, nodes: [3, 4] },
            ],
        };

        const result = analyzeMemberOrder(full, '1');
        expect(result.topology).toBe('linear');
        expect(result.continuous).toBe(false);
        expect(result.proposal?.map(way => way.id)).toEqual(['10', '11', '12']);
    });

    it('recognizes a continuous ring without proposing a change', () => {
        const full: OsmFullResponse = {
            elements: [
                { type: 'relation', id: 1, members: [
                    { type: 'way', ref: 12 }, { type: 'way', ref: 10 }, { type: 'way', ref: 11 },
                ] },
                { type: 'way', id: 10, nodes: [1, 2] },
                { type: 'way', id: 11, nodes: [2, 3] },
                { type: 'way', id: 12, nodes: [3, 1] },
            ],
        };

        const result = analyzeMemberOrder(full, '1');
        expect(result.topology).toBe('ring');
        expect(result.continuous).toBe(true);
        expect(result.changes).toBe(0);
    });

    it('moves ways while preserving non-way slots and each role', () => {
        const members: RelationMember[] = [
            { type: 'way', id: 'w1', role: 'forward' },
            { type: 'node', id: 'n1', role: 'label' },
            { type: 'way', id: 'w2', role: 'backward' },
            { type: 'relation', id: 'r2', role: 'subroute' },
        ];

        expect(reorderWayMembers(members, [1, 0])).toEqual([
            members[2], members[1], members[0], members[3],
        ]);
        expect(reorderWayMembers(members, [0, 0])).toBeNull();
    });
});