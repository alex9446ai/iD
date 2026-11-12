import { osmIdManager, type EntityId, type RelationId } from '../../osm';
import type { RelationMember } from '../../osm/relation';
import { uiSection } from '../section';
import { loadRouteData, type RouteData } from '../../osm2cai/api';
import { alignmentStatus, latestOsmTimestamp, modifiedElementsSince, validationDateKind } from '../../osm2cai/alignment';
import { analyzeMemberOrder, reorderWayMembers, type OrderedWay } from '../../osm2cai/member_order';
import type { OsmApiElement, OsmFullResponse } from '../../osm2cai/types';

const STATUS_COLORS: Record<string, string> = {
    ok: '#22bd3c', warning: '#e7b743', error: '#ed3043', orange: '#f59e0b', gray: '#9ca3af',
};

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
}

function formatDate(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) return '—';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return value;
    return new Intl.DateTimeFormat('it-IT', {
        timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'short',
    }).format(date);
}

function memberSignature(members: RelationMember[]) {
    return JSON.stringify(members.map(member => [member.type, member.id, member.role || '']));
}

function relationFromGraph(context: iD.Context, relationId: RelationId) {
    const entity = context.graph().hasEntity(relationId);
    return entity?.type === 'relation' ? entity : null;
}

function withCurrentMembers(full: OsmFullResponse, relationId: RelationId, members: RelationMember[]): OsmFullResponse {
    const osmId = osmIdManager.toOSM(relationId);
    const currentMembers = members.map(member => ({
        type: member.type as OsmApiElement['type'],
        ref: osmIdManager.toOSM(member.id),
        role: member.role,
    }));
    return {
        elements: (full.elements || []).map(element =>
            element.type === 'relation' && String(element.id) === osmId
                ? { ...element, members: currentMembers }
                : element
        ),
    };
}

export function uiSectionOsm2Cai(context: iD.Context) {
    let entityIDs: EntityId[] = [];
    let requestedRelationId: RelationId | null = null;
    let requestController: AbortController | null = null;
    let requestState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
    let routeData: RouteData | null = null;
    let requestError = '';

    const section: any = (uiSection('osm2cai-route', context) as any)
        .label(() => 'OSM2CAI')
        .expandedByDefault(true)
        .shouldDisplay(() => {
            if (entityIDs.length !== 1) return false;
            const relation = context.graph().hasEntity(entityIDs[0]);
            return relation?.type === 'relation' && relation.tags.route === 'hiking' &&
                /^r[1-9]\d{0,15}$/.test(relation.id) && Number.isSafeInteger(Number(relation.id.slice(1)));
        })
        .disclosureContent(renderContent);

    section.entityIDs = function(value?: EntityId[]) {
        if (value === undefined) return entityIDs;
        entityIDs = value;
        const nextId = entityIDs.length === 1 && entityIDs[0].startsWith('r') ? entityIDs[0] as RelationId : null;
        if (nextId !== requestedRelationId) {
            requestController?.abort();
            requestController = null;
            requestedRelationId = null;
            routeData = null;
            requestState = 'idle';
            requestError = '';
        }
        return section;
    };

    function currentRelationId(): RelationId | null {
        if (entityIDs.length !== 1 || !entityIDs[0].startsWith('r')) return null;
        const relation = context.graph().hasEntity(entityIDs[0]);
        return relation?.type === 'relation' && relation.tags.route === 'hiking'
            ? relation.id as RelationId
            : null;
    }

    function startRequest(relationId: RelationId) {
        if (requestedRelationId === relationId && requestState !== 'idle') return;
        requestController?.abort();
        const controller = new AbortController();
        requestController = controller;
        requestedRelationId = relationId;
        requestState = 'loading';
        requestError = '';
        routeData = null;
        let timedOut = false;
        const timer = window.setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, 12000);
        loadRouteData(osmIdManager.toOSM(relationId), controller.signal).then(result => {
            if (requestController !== controller) return;
            if (controller.signal.aborted) {
                requestState = 'error';
                requestError = timedOut ? 'Richiesta scaduta. Riprova.' : 'Richiesta annullata.';
                section.reRender();
                return;
            }
            routeData = result;
            requestState = 'ready';
            section.reRender();
        }).catch(error => {
            if (requestController !== controller) return;
            requestState = 'error';
            requestError = timedOut ? 'Richiesta scaduta. Riprova.'
                : error instanceof Error ? error.message : 'Caricamento non riuscito.';
            section.reRender();
        }).finally(() => window.clearTimeout(timer));
    }

    function renderContent(selection: d3.Selection) {
        const container = selection.node() as HTMLElement | null;
        if (!container) return;
        container.replaceChildren();
        const relationId = currentRelationId();
        if (!relationId) return;
        if (requestedRelationId !== relationId || requestState === 'idle') startRequest(relationId);

        if (requestState === 'loading' || requestState === 'idle') {
            container.appendChild(node('p', 'Caricamento dati OSM e OSM2CAI…'));
            return;
        }
        if (requestState === 'error') {
            const message = node('p', `Dati non disponibili: ${requestError}`);
            const retry = node('button', 'Riprova');
            retry.type = 'button';
            retry.addEventListener('click', () => {
                requestedRelationId = null;
                requestState = 'idle';
                startRequest(relationId);
                section.reRender();
            });
            container.append(message, retry);
            return;
        }

        const relation = relationFromGraph(context, relationId);
        if (!relation || !routeData) return;
        renderDashboard(container, relationId, routeData);
        renderOrderAnalysis(container, relationId, routeData, relation.members);
    }

    function renderDashboard(container: HTMLElement, relationId: RelationId, data: RouteData) {
        const properties = data.osm2cai?.properties;
        const osmTimestamp = data.osm ? latestOsmTimestamp(data.osm, osmIdManager.toOSM(relationId)) : null;
        const alignment = alignmentStatus(properties, osmTimestamp);
        const dashboard = node('div');
        dashboard.className = 'osm2cai-dashboard';
        dashboard.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:8px;margin:0 0 12px;';

        addMetric(dashboard, 'OSM2CAI API', data.osm2caiError ? 'non disponibile' : 'online', data.osm2caiError ? 'error' : 'ok');
        addMetric(dashboard, 'SDA', properties?.sda ?? '—', 'gray');

        const rawIssues = String(properties?.issues_status ?? '').trim();
        const normalizedIssues = rawIssues.toLocaleLowerCase('it-IT').replace(/\s+/g, ' ');
        const issueKind = normalizedIssues === 'percorribile' ? 'ok'
            : normalizedIssues === 'non percorribile' ? 'error'
                : ['parzialmente percorribile', 'percorribile parzialmente'].includes(normalizedIssues) ? 'orange' : 'gray';
        const issueLabel = issueKind === 'orange' ? 'parzialmente percorribile' : rawIssues || 'sconosciuto';
        addMetric(dashboard, 'Percorribilità', issueLabel, issueKind);

        const validationDate = typeof properties?.validation_date === 'string' && properties.validation_date.trim()
            ? properties.validation_date.trim() : '—';
        addMetric(dashboard, 'Data validazione', validationDate, validationDateKind(properties?.validation_date));
        addMetric(dashboard, 'Allineamento', alignment.label, alignment.kind);

        if (properties?.issues_description || properties?.issues_last_update) {
            const detail = node('details');
            detail.style.margin = '0 0 10px';
            const summary = node('summary', 'Dettagli percorribilità');
            const text = node('p', properties.issues_description?.trim() || 'Descrizione non disponibile.');
            text.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;';
            const updated = node('p', `Ultimo aggiornamento: ${formatDate(properties.issues_last_update)}`);
            detail.append(summary, text, updated);
            container.appendChild(detail);
        }

        if (properties?.id !== undefined && properties.id !== null) {
            const link = node('a', 'Apri scheda OSM2CAI');
            link.href = `https://osm2cai.cai.it/resources/hiking-routes/${encodeURIComponent(String(properties.id))}`;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.style.display = 'inline-block';
            link.style.margin = '0 0 10px';
            container.appendChild(link);
        }

        if (data.osm2caiError) {
            const warning = node('p', data.osm2caiError);
            warning.className = 'warning';
            container.appendChild(warning);
        }
        if (data.osmError) {
            const warning = node('p', data.osmError);
            warning.className = 'warning';
            container.appendChild(warning);
        }

        if (data.osm && String(properties?.sda ?? '').trim() === '4' && alignment.label === 'da verificare') {
            const modified = modifiedElementsSince(data.osm, properties?.validation_date);
            if (modified.length) {
                const details = node('details');
                const summary = node('summary', `Elementi modificati dopo la validazione (${modified.length})`);
                const list = node('ul');
                list.style.cssText = 'max-height:180px;overflow:auto;padding-left:22px;';
                for (const item of modified.slice(0, 80)) {
                    if (!['node', 'way', 'relation'].includes(item.type) || !Number.isSafeInteger(Number(item.id))) continue;
                    const row = node('li');
                    const link = node('a', `${item.type} ${item.id}`);
                    link.href = `https://www.openstreetmap.org/${item.type}/${encodeURIComponent(String(item.id))}`;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                    row.append(link, document.createTextNode(` · ${item.timestamp?.slice(0, 10) || '—'} · ${item.user || 'utente non disponibile'}`));
                    list.appendChild(row);
                }
                details.append(summary, list);
                if (modified.length > 80) details.appendChild(node('p', `Visualizzati 80 elementi su ${modified.length}.`));
                container.appendChild(details);
            }
        }
        container.prepend(dashboard);
    }

    function addMetric(container: HTMLElement, label: string, value: unknown, kind: string) {
        const item = node('div');
        item.style.cssText = 'min-width:0;padding:5px 7px;border-left:3px solid #d8dfe7;overflow-wrap:anywhere;';
        const title = node('div', label);
        title.style.cssText = 'font-size:11px;opacity:.75;';
        const output = node('div', String(value));
        output.style.fontWeight = '600';
        const color = STATUS_COLORS[kind] || STATUS_COLORS.gray;
        item.style.borderLeftColor = color;
        item.append(title, output);
        container.appendChild(item);
    }

    function renderOrderAnalysis(container: HTMLElement, relationId: RelationId, data: RouteData, members: RelationMember[]) {
        if (!data.osm) {
            const message = node('p', data.osmError || 'Dati OSM non disponibili: analisi relazione non eseguibile.');
            container.appendChild(message);
            return;
        }
        const full = withCurrentMembers(data.osm, relationId, members);
        const result = analyzeMemberOrder(full, osmIdManager.toOSM(relationId));
        const heading = node('h3', 'Analisi relazione');
        heading.style.cssText = 'font-size:14px;margin:10px 0 6px;';
        container.appendChild(heading);

        if (result.error) {
            const message = node('p', result.error);
            message.style.overflowWrap = 'anywhere';
            container.appendChild(message);
            return;
        }

        const labels: Record<string, string> = {
            linear: 'Percorso lineare', ring: 'Percorso ad anello', branching: 'Percorso con diramazioni',
            disconnected: 'Componenti scollegate', complex: 'Topologia complessa',
        };
        container.appendChild(node('p', `Topologia: ${labels[result.topology || 'complex']}.`));
        container.appendChild(node('p', `Way: ${result.total} · sequenza attuale continua: ${result.continuous ? 'sì' : 'no'} · interruzioni: ${result.breaks}.`));
        if (result.nonWays) container.appendChild(node('p', `Altri membri node/relation: ${result.nonWays}; non vengono spostati.`));
        if (result.repeated) container.appendChild(node('p', `Way ripetute: ${result.repeated}.`));
        if (result.branches) container.appendChild(node('p', `Biforcazioni: ${result.branches}.`));
        if (result.roleSensitive) container.appendChild(node('p', 'Sono presenti ruoli way: riordino automatico sospeso.'));
        if (result.nestedRelations) container.appendChild(node('p', `Sottorelazioni: ${result.nestedRelations}; incluse nell’analisi, ma non riordinate automaticamente.`));

        if (result.issues?.length) {
            const list = node('ul');
            list.style.paddingLeft = '22px';
            for (const issue of result.issues.slice(0, 80)) {
                const row = node('li');
                const button = node('button', `${issue.label} · node ${issue.nodeId} · inquadra`);
                button.type = 'button';
                button.addEventListener('click', () => focusNode(issue.nodeId));
                row.appendChild(button);
                list.appendChild(row);
            }
            container.appendChild(list);
        }

        if (!result.proposal || !result.proposal.length) {
            container.appendChild(node('p', 'Riordino automatico non proposto: verifica manualmente la struttura della relazione.'));
            return;
        }
        const preview = node('ol');
        preview.style.cssText = 'max-height:180px;overflow:auto;padding-left:24px;';
        for (const way of result.proposal) preview.appendChild(node('li', `way ${way.id}`));
        container.appendChild(preview);

        if (!result.changes) {
            container.appendChild(node('p', result.ring ? 'Le way formano un anello continuo.' : 'Le way sono già in un ordine continuo.'));
            if (result.continuous) {
                const reverse = node('button', 'Forza ordinamento inverso');
                reverse.type = 'button';
                reverse.addEventListener('click', () => {
                    const wayCount = members.filter(member => member.type === 'way').length;
                    applyOrder(relationId, members, Array.from({ length: wayCount }, (_, index) => wayCount - index - 1), 'Invertire l’ordine delle way');
                });
                container.appendChild(reverse);
            }
            return;
        }

        const elevation = orderElevationHint(data.osm, result.proposal);
        let direction: 'proposed' | 'inverse' = elevation && elevation.start > elevation.end ? 'inverse' : 'proposed';
        if (elevation && elevation.start !== elevation.end) {
            const note = node('p', 'Preselezionato il verso da quota minore a maggiore usando i tag ele degli estremi OSM.');
            note.style.fontSize = '12px';
            container.appendChild(note);
        }
        const controls = node('fieldset');
        controls.style.cssText = 'border:0;padding:0;margin:8px 0;';
        const legend = node('legend', 'Verso della sequenza');
        controls.appendChild(legend);
        const options: Array<{ key: 'proposed' | 'inverse'; label: string }> = [
            { key: 'proposed', label: 'Ordine proposto' },
            { key: 'inverse', label: 'Ordine inverso' },
        ];
        let previewList = node('ol');
        previewList.style.cssText = 'max-height:180px;overflow:auto;padding-left:24px;';
        const drawPreview = () => {
            const ordered = direction === 'inverse' ? [...result.proposal!].reverse() : result.proposal!;
            previewList.replaceChildren(...ordered.map(way => node('li', `way ${way.id}`)));
        };
        const changeDirection = (next: 'proposed' | 'inverse') => () => {
            direction = next;
            drawPreview();
        };
        for (const option of options) {
            const label = node('label');
            label.style.cssText = 'display:inline-flex;align-items:center;gap:5px;margin-right:12px;';
            const input = node('input');
            input.type = 'radio';
            input.name = `osm2cai-direction-${relationId}`;
            input.value = option.key;
            input.checked = option.key === direction;
            input.addEventListener('change', changeDirection(option.key));
            label.append(input, document.createTextNode(option.label));
            controls.appendChild(label);
        }
        drawPreview();
        container.append(controls, previewList);
        const apply = node('button', 'Ordina membri in iD');
        apply.type = 'button';
        apply.addEventListener('click', () => {
            const ordered = direction === 'inverse' ? [...result.proposal!].reverse() : result.proposal!;
            const verb = direction === 'inverse' ? 'Applicare l’ordine inverso' : 'Applicare l’ordine proposto';
            applyOrder(relationId, members, ordered.map(way => way.index), verb);
        });
        container.appendChild(apply);
        const note = node('p', 'La modifica resta nella sessione iD, è annullabile e non viene salvata automaticamente su OpenStreetMap.');
        note.style.cssText = 'font-size:12px;opacity:.8;';
        container.appendChild(note);
    }

    function applyOrder(relationId: RelationId, expectedMembers: RelationMember[], order: number[], prompt: string) {
        const current = relationFromGraph(context, relationId);
        if (!current || memberSignature(current.members) !== memberSignature(expectedMembers)) {
            window.alert('La relazione è cambiata: ripeti l’analisi.');
            return;
        }
        const members = reorderWayMembers(current.members, order);
        if (!members || memberSignature(members) === memberSignature(current.members)) return;
        if (!window.confirm(`${prompt} nella relazione ${osmIdManager.toOSM(relationId)}? La modifica non verrà salvata automaticamente.`)) return;
        const expected = memberSignature(current.members);
        context.perform(graph => {
            const latest = graph.hasEntity(relationId);
            if (latest?.type !== 'relation' || memberSignature(latest.members) !== expected) return graph;
            return graph.replace(latest.update({ members }));
        }, 'OSM2CAI: riordino membri relazione ' + osmIdManager.toOSM(relationId));
        context.validator().validate();
    }

    function focusNode(nodeId: string) {
        const id = `n${nodeId}` as EntityId;
        if (context.graph().hasEntity(id)) {
            context.zoomToEntity(id);
            return;
        }
        context.loadEntity(id, (error) => {
            if (!error && context.graph().hasEntity(id)) context.zoomToEntity(id);
        });
    }

    function orderElevationHint(full: OsmFullResponse, sequence: OrderedWay[]) {
        if (sequence.length < 2) return null;
        const elements = full.elements || [];
        const ways = new Map(elements.filter(item => item.type === 'way').map(item => [String(item.id), item]));
        const nodes = new Map(elements.filter(item => item.type === 'node').map(item => [String(item.id), item]));
        const first = ways.get(sequence[0].id);
        const second = ways.get(sequence[1].id);
        const last = ways.get(sequence[sequence.length - 1].id);
        const beforeLast = ways.get(sequence[sequence.length - 2].id);
        if (![first, second, last, beforeLast].every(way => way?.nodes && way.nodes.length >= 2)) return null;
        const terminal = (way: OsmApiElement, neighbor: OsmApiElement) => {
            const ends = [String(way.nodes![0]), String(way.nodes![way.nodes!.length - 1])];
            const adjacent = new Set([String(neighbor.nodes![0]), String(neighbor.nodes![neighbor.nodes!.length - 1])]);
            const unique = ends.filter(id => !adjacent.has(id));
            return unique.length === 1 ? unique[0] : null;
        };
        const startId = terminal(first!, second!);
        const endId = terminal(last!, beforeLast!);
        if (!startId || !endId || startId === endId) return null;
        const elevation = (id: string) => {
            const raw = nodes.get(id)?.tags?.ele;
            if (typeof raw !== 'string' || !/^[-+]?\d+(?:[.,]\d+)?(?:\s*m)?$/i.test(raw.trim())) return null;
            const value = Number(raw.trim().replace(/\s*m$/i, '').replace(',', '.'));
            return Number.isFinite(value) && value >= -500 && value <= 9000 ? value : null;
        };
        const start = elevation(startId);
        const end = elevation(endId);
        return start === null || end === null ? null : { start, end };
    }

    return section;
}