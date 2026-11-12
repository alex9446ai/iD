import { select as d3_select, selectAll as d3_selectAll } from 'd3-selection';
import { uiSectionOsm2Cai } from '../../../modules/ui/sections/osm2cai';

describe('iD OSM2CAI relation section', () => {
    let context: iD.Context;
    let section: any;
    let wrapper: d3.Selection<HTMLDivElement>;
        let relation: iD.OsmRelation;

    beforeEach(() => {
        relation = new iD.osmRelation({
            id: 'r123',
            tags: { type: 'route', route: 'hiking' },
            version: 5,
            members: [
                { type: 'way', id: 'w10', role: '' },
                { type: 'node', id: 'n5', role: 'label' },
                { type: 'way', id: 'w12', role: '' },
                { type: 'way', id: 'w11', role: '' },
            ],
        });
        context = iD.coreContext().assetPath('../dist/').init();
        context.history().merge([relation]);
        const full = {
            elements: [
                { type: 'relation', id: 123, version: 5, timestamp: '2026-05-04T10:00:00Z', members: [
                    { type: 'way', ref: 10, role: '' }, { type: 'node', ref: 5, role: 'label' },
                    { type: 'way', ref: 12, role: '' }, { type: 'way', ref: 11, role: '' },
                ] },
                { type: 'way', id: 10, timestamp: '2026-05-01T10:00:00Z', nodes: [1, 2] },
                { type: 'way', id: 11, timestamp: '2026-05-02T10:00:00Z', nodes: [2, 3] },
                { type: 'way', id: 12, timestamp: '2026-05-03T10:00:00Z', nodes: [3, 4] },
                { type: 'node', id: 1, lat: 45, lon: 9, timestamp: '2026-05-01T10:00:00Z' },
                { type: 'node', id: 2, lat: 45.1, lon: 9, timestamp: '2026-05-01T10:00:00Z' },
                { type: 'node', id: 3, lat: 45.2, lon: 9, timestamp: '2026-05-02T10:00:00Z' },
                { type: 'node', id: 4, lat: 45.3, lon: 9, timestamp: '2026-05-03T10:00:00Z' },
                { type: 'node', id: 5, lat: 45.1, lon: 9.1, timestamp: '2026-05-01T10:00:00Z' },
            ],
        };
        vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
            const url = String(input);
            const body = url.includes('osm2cai.cai.it')
                ? { properties: { id: 456, sda: '4', issues_status: 'percorribile', validation_date: '2026-05-01' } }
                : full;
            return Promise.resolve({
                ok: true,
                status: 200,
                url,
                text: () => Promise.resolve(JSON.stringify(body)),
            });
        }));
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        section = uiSectionOsm2Cai(context).entityIDs([relation.id]);
        wrapper = d3_select('body').append('div').attr('class', 'osm2cai-test-wrap');
        wrapper.call(section.render);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        d3_selectAll('.osm2cai-test-wrap').remove();
    });

    it('loads the dashboard and reorders ways without moving non-way members', async () => {
        await vi.waitFor(() => {
            expect(wrapper.select('.osm2cai-dashboard').empty()).toBe(false);
        });
        expect(wrapper.text()).toContain('OSM2CAI API');
        expect(wrapper.text()).toContain('Percorribilità');

            const apply = wrapper.selectAll<HTMLButtonElement, unknown>('button').nodes().find(button =>
            button.textContent === 'Ordina membri in iD'
            );
        expect(apply).toBeTruthy();
            if (!apply) throw new Error('Pulsante di riordino non trovato.');
            apply.click();

            const updated = context.graph().hasEntity(relation.id);
            if (updated?.type !== 'relation') throw new Error('La relazione è scomparsa dal grafo.');
            expect(updated.members.map(member => member.id)).toEqual([
            'w10', 'n5', 'w11', 'w12',
        ]);
    });
});