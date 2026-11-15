import type { Quote } from './types.ts'

/**
 * Bridges whose terms restrict where (or by whom) they may be used, from the terms review in
 * docs/PLAN.md. Keyed by LI.FI bridge key. A bridge missing here has no geo restriction in
 * its terms, or has no terms at all. Update this list together with the review table.
 *
 * Many terms say "territories under comprehensive sanctions" instead of naming countries; for
 * those, `regions` is the usual set and `note` says the terms point to the live sanctions lists.
 */
export interface GeoRestriction {
  /** Service name shown to the user. */
  name: string
  /** Countries and regions where the service may not be used. */
  regions: string[]
  /** Reverse case: the service may only be used in `regions`. */
  onlyIn?: boolean
  /** Caveats, e.g. the terms refer to sanctions lists that change. */
  note?: string
  /** Terms document the entry comes from. */
  terms: string
}

const SANCTIONED = ['Cuba', 'Iran', 'North Korea', 'Syria', 'Crimea, Donetsk and Luhansk regions of Ukraine']
const LISTS = 'The terms refer to the current sanctions lists, which change; sanctioned persons are barred everywhere.'
const CIRCLE = { name: 'Circle CCTP', regions: SANCTIONED, note: LISTS, terms: 'Circle Technology Services MSA, 6 Mar 2025' }
const MAYAN = { name: 'Mayan', regions: SANCTIONED, note: LISTS, terms: 'Sand Lake Labs Terms of Service, Aug 2025' }

export const GEO_RESTRICTIONS: Record<string, GeoRestriction> = {
  arbitrum: { name: 'Arbitrum Bridge', regions: SANCTIONED, note: LISTS, terms: 'Offchain Labs Terms of Service, 11 Mar 2026' },
  across: { name: 'Across', regions: SANCTIONED, note: LISTS, terms: 'Risk Labs Terms of Service, 21 Oct 2026' },
  squid: { name: 'Squid', regions: ['Cuba', 'Iran', 'North Korea', 'Syria'], note: 'Persons on UN, Panama, US, UK and EU sanctions lists are barred everywhere.', terms: 'Ceiba Network Terms of Service, 4 Aug 2026' },
  mayan: MAYAN,
  mayanWH: MAYAN,
  mayanMCTP: { ...MAYAN, regions: [...new Set([...MAYAN.regions, ...CIRCLE.regions])], note: `${LISTS} The USDC leg also falls under Circle's CCTP terms.` },
  mayanFastMCTP: { ...MAYAN, regions: [...new Set([...MAYAN.regions, ...CIRCLE.regions])], note: `${LISTS} The USDC leg also falls under Circle's CCTP terms.` },
  stargateV2: { name: 'Stargate', regions: SANCTIONED, note: LISTS, terms: 'Stargate Foundation Terms of Use, 17 Sep 2025' },
  stargateV2Bus: { name: 'Stargate', regions: SANCTIONED, note: LISTS, terms: 'Stargate Foundation Terms of Use, 17 Sep 2025' },
  cctp: CIRCLE,
  celercircle: { ...CIRCLE, name: 'Celer (CCTP)', note: `${LISTS} Celer has no terms of its own; the USDC leg falls under Circle's.` },
  celercirclefast: { ...CIRCLE, name: 'Celer (CCTP)', note: `${LISTS} Celer has no terms of its own; the USDC leg falls under Circle's.` },
  polymerStandard: { ...CIRCLE, name: 'Polymer (Standard)', note: `${LISTS} Polymer has no terms of its own; the route is built on Circle CCTP.` },
  symbiosis: { name: 'Symbiosis', regions: ['United States (persons and residents)', ...SANCTIONED.filter((r) => r !== 'Syria'), 'Sevastopol', 'Syria'], note: 'The terms also forbid VPNs to get around this.', terms: 'Symbiosis Foundation Terms of Use, Sep 2026' },
  polygon: { name: 'Polygon Bridge (PoS)', regions: SANCTIONED, note: LISTS, terms: 'Polygon Labs Terms of Use, 10 Nov 2026' },
  glacis: { name: 'Glacis', regions: SANCTIONED, note: LISTS, terms: 'Glacis Labs ZeroDelta Terms of Service, 24 Aug 2026' },
  gasZipBridge: { name: 'GasZip', regions: ['United States'], onlyIn: true, note: 'The website terms say the service is only for people located in the United States.', terms: 'Size Research Terms of Service, 1 Feb 2024' },
  relaydepository: {
    name: 'Relay',
    regions: ['Cuba', 'Iran', 'North Korea', 'Crimea, Donetsk and Luhansk regions of Ukraine', 'any other country under comprehensive US sanctions or an arms embargo'],
    note: 'The terms also forbid VPNs to get around this.',
    terms: 'Uneven Labs Terms of Use, 9 Nov 2026',
  },
  // Denied by default (operator-run, not permissionless); kept so the list stays correct if it is ever enabled.
  unit: { name: 'Unit', regions: ['United States', 'sanctioned countries listed in the terms'], note: 'Enforced by IP geofencing and VPN blocking.', terms: 'Hyperunit Terms of Service, Nov 2024' },
  eco: { name: 'Eco', regions: SANCTIONED, note: LISTS, terms: 'Eco, Inc. Terms of Service, 23 Jul 2026' },
  superset: { name: 'Superset', regions: SANCTIONED, note: LISTS, terms: 'Superset Terms, 20 Apr 2026' },
  garden: {
    name: 'Garden',
    regions: [
      'Iran', 'North Korea', 'Myanmar', 'Pakistan', 'China', 'Russia', 'Syria', 'Sudan', 'Cuba', 'United States', 'European Union', 'Canada', 'Estonia',
      'United Arab Emirates', 'Hong Kong', 'Singapore', 'FATF blacklisted countries', 'countries under UN sanctions or a US embargo',
      'countries that require a licence for digital asset services',
    ],
    note: 'The terms also forbid VPNs.',
    terms: 'Garden Finance Terms of Service, 19 Nov 2025',
  },
  layerswap: { name: 'Layerswap', regions: ['Iran', 'Cuba', 'North Korea', 'Syria', 'other states and territories listed in the terms'], note: 'The terms also forbid VPNs to get around this.', terms: 'Layerswap Labs Terms of Service, 5 May 2025' },
  paxos: { name: 'Paxos Labs Transit', regions: ['Cuba', 'Iran', 'North Korea', 'Syria', 'Russia', 'Crimea', 'jurisdictions that restrict crypto'], note: 'The terms also forbid VPNs.', terms: 'Paxos Labs Terms of Use, 2025' },
}

/** Bridges excluded from the default route search (see the terms review in docs/PLAN.md). */
export const DEFAULT_DENIED_BRIDGES = ['paxos', 'unit']

export interface GeoNotice extends GeoRestriction {
  /** LI.FI bridge keys behind this service that the route uses. */
  keys: string[]
}

export const isGeoRestricted = (q: Pick<Quote, 'provider' | 'tool'>): boolean => q.provider === 'lifi' && q.tool in GEO_RESTRICTIONS

/** The geo-restricted services a set of quotes (one route) passes through, one entry per service. */
export function geoNotices(quotes: Pick<Quote, 'provider' | 'tool'>[]): GeoNotice[] {
  const byName = new Map<string, GeoNotice>()
  for (const q of quotes.filter(isGeoRestricted)) {
    const r = GEO_RESTRICTIONS[q.tool]!
    const entry = byName.get(r.name)
    if (entry) entry.keys.push(q.tool)
    else byName.set(r.name, { ...r, keys: [q.tool] })
  }
  return [...byName.values()]
}

/** Bridge keys of the quotes that need the user's location confirmation. */
export const geoKeys = (quotes: Pick<Quote, 'provider' | 'tool'>[]): string[] => [...new Set(quotes.filter(isGeoRestricted).map((q) => q.tool))]

/** Whether a quote may be used given the bridge keys the user confirmed their location for. */
export const geoAllowed = (q: Pick<Quote, 'provider' | 'tool'>, accepted: string[] | undefined): boolean => !isGeoRestricted(q) || (accepted ?? []).includes(q.tool)

/** The statement the user must accept. */
export function geoStatement(notices: GeoNotice[]): string {
  const only = notices.some((n) => n.onlyIn)
  return only
    ? 'I confirm that I am currently in none of the restricted countries or regions listed above, and in the permitted country where a service is limited to one.'
    : 'I confirm that I am currently in none of the restricted countries or regions listed above.'
}
