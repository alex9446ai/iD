export type OsmElementType = 'node' | 'way' | 'relation';

export interface OsmApiMember {
    type: OsmElementType;
    ref: number | string;
    role?: string;
}

export interface OsmApiElement {
    type: OsmElementType;
    id: number | string;
    version?: number;
    timestamp?: string;
    user?: string;
    lat?: number;
    lon?: number;
    nodes?: Array<number | string>;
    members?: OsmApiMember[];
    tags?: Record<string, string>;
}

export interface OsmFullResponse {
    elements?: OsmApiElement[];
}

export interface Osm2CaiProperties {
    id?: number | string;
    sda?: number | string;
    issues_status?: string;
    issues_description?: string;
    issues_last_update?: string;
    validation_date?: string;
    updated_at?: string;
}

export interface Osm2CaiResponse {
    properties?: Osm2CaiProperties;
    geometry?: unknown;
}