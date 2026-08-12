/**
 * Compatibility layer between GBFS 2.x and 3.0.
 *
 * Everything downstream of this module only ever sees the 3.0 shape: localized strings
 * resolved to a single string, instants as RFC3339, and the 3.0 field names. The five
 * differences that matter for the data we extract are handled here and nowhere else.
 */

export interface GbfsDocument<T = any> {
  /** RFC3339 instant at which the feed was generated, whatever the version's encoding */
  lastUpdated?: string
  version: string
  data: T
  /** the document as the service published it, kept to be attached untouched */
  raw: any
}

/** GBFS 2.x file names that were renamed in 3.0. */
export const FEED_ALIASES: Record<string, string> = {
  free_bike_status: 'vehicle_status'
}

/**
 * GBFS 2.x counts seconds since the epoch, 3.0 uses RFC3339. An unparsable value is
 * dropped rather than published: a wrong date is worse than a missing one.
 */
export const isoInstant = (value: unknown): string | undefined => {
  if (value === null || value === undefined || value === '') return undefined
  let date: Date
  if (typeof value === 'number') date = new Date(value * 1000)
  // a few 2.x feeds quote their POSIX timestamps
  else if (typeof value === 'string' && /^\d{9,11}$/.test(value)) date = new Date(Number(value) * 1000)
  else date = new Date(String(value))
  return isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** Same, for the plain dates 3.0 introduced (terms_last_updated…). */
export const isoDate = (value: unknown): string | undefined => isoInstant(value)?.slice(0, 10)

/**
 * A 3.0 localized string is an array of {text, language}, a 2.x one is a plain string.
 * The requested language wins; without it the first one published is used, because a
 * feed that publishes a single language rarely tags it the way the user expects.
 */
export const localized = (value: unknown, language?: string): string | undefined => {
  if (typeof value === 'string') return text(value)
  if (!Array.isArray(value)) return undefined
  const entries = value.filter((entry: any) => entry && typeof entry.text === 'string')
  if (!entries.length) return undefined
  const wanted = language && entries.find((entry: any) => entry.language === language)
  return text((wanted || entries[0]).text)
}

export const text = (value: unknown): string | undefined => {
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

export const num = (value: unknown): number | undefined => {
  if (typeof value === 'number') return isNaN(value) ? undefined : value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value)
  return isNaN(parsed) ? undefined : parsed
}

/** Some 2.x feeds encode booleans as 0/1. */
export const bool = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || value === 'true') return true
  if (value === 0 || value === '0' || value === 'false') return false
  return undefined
}

/** Arrays of scalars become a separator-joined string: data-fair lines must stay flat. */
export const list = (value: unknown, separator = ';'): string | undefined => {
  if (!Array.isArray(value)) return undefined
  const items = value.map(item => text(item)).filter((item): item is string => !!item)
  return items.length ? items.join(separator) : undefined
}

export const geometry = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const geo = value as any
  if (!geo.type || !geo.coordinates) return undefined
  return JSON.stringify(geo)
}

export const readDocument = <T = any>(raw: any, source: string): GbfsDocument<T> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Le flux ${source} ne contient pas un objet JSON.`)
  }
  if (raw.data === undefined || raw.data === null) {
    throw new Error(`Le flux ${source} ne contient pas de propriété "data".`)
  }
  return {
    lastUpdated: isoInstant(raw.last_updated),
    // a feed that does not state its version is a 1.0 one, per the specification
    version: text(raw.version) ?? '1.0',
    data: raw.data as T,
    raw
  }
}

/**
 * Read the feed list out of gbfs.json.
 *
 * 3.0 lists the feeds directly under `data`, 2.x nests one list per language. The 2.x
 * lists are duplicates of each other — only the localized content behind the URLs
 * differs — so falling back to the first published language is safe.
 */
export const discoverFeeds = (raw: any, language?: string): Record<string, string> => {
  const data = raw?.data
  if (!data || typeof data !== 'object') {
    throw new Error('Le fichier gbfs.json ne contient pas de propriété "data". Vérifiez que l\'URL pointe bien vers le fichier de découverte du service.')
  }

  let feeds = data.feeds
  if (!Array.isArray(feeds)) {
    const wanted = language && data[language]?.feeds
    feeds = Array.isArray(wanted)
      ? wanted
      : Object.values(data).map((entry: any) => entry?.feeds).find(Array.isArray)
  }
  if (!Array.isArray(feeds)) {
    throw new Error('Le fichier gbfs.json ne déclare aucun flux. Vérifiez que l\'URL pointe bien vers le fichier de découverte du service.')
  }

  const urls: Record<string, string> = {}
  for (const feed of feeds) {
    const name = text(feed?.name)?.replace(/\.json$/, '')
    const url = text(feed?.url)
    if (!name || !url) continue
    urls[FEED_ALIASES[name] ?? name] = url
  }
  return urls
}

/** 2.x called them bikes. */
export const vehiclesOf = (data: any): any[] => {
  const vehicles = data?.vehicles ?? data?.bikes
  return Array.isArray(vehicles) ? vehicles : []
}

export const vehicleIdOf = (row: any): string | undefined => text(row?.vehicle_id ?? row?.bike_id)

export const numVehiclesAvailableOf = (row: any): number | undefined =>
  num(row?.num_vehicles_available ?? row?.num_bikes_available)

export const numVehiclesDisabledOf = (row: any): number | undefined =>
  num(row?.num_vehicles_disabled ?? row?.num_bikes_disabled)
