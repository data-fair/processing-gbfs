import type { AxiosInstance } from 'axios'
import type { LogFunctions } from '@data-fair/lib-common-types/processings.js'
import { discoverFeeds, readDocument, type GbfsDocument } from './normalize.ts'

/** The processing axios instance is created with maxRedirects: 0 and would stop at the first 302. */
const REQUEST_OPTIONS = { maxRedirects: 4, timeout: 60000, responseType: 'json' as const }

export interface GbfsService {
  /** version announced by gbfs.json */
  version: string
  /** feed name (3.0 naming) to URL */
  feedUrls: Record<string, string>
  /** gbfs.json itself, kept to be attached untouched */
  discovery: any
}

export const fetchJson = async (url: string, axios: AxiosInstance, source: string): Promise<any> => {
  let data: any
  try {
    data = (await axios.get(url, REQUEST_OPTIONS)).data
  } catch (err: any) {
    if (err.response?.status === 404) throw new Error(`Le flux ${source} est introuvable (404) : ${url}`)
    const status = err.response?.status ? ` (HTTP ${err.response.status})` : ''
    throw new Error(`Échec de la récupération du flux ${source}${status} : ${err.message}`)
  }
  // a server answering with the wrong content-type leaves axios with a raw string
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      throw new Error(`Le flux ${source} n'est pas du JSON valide : ${url}`)
    }
  }
  return data
}

/**
 * Read gbfs.json and resolve the URL of every feed the service publishes.
 */
export const discover = async (
  url: string,
  language: string | undefined,
  axios: AxiosInstance,
  log: LogFunctions
): Promise<GbfsService> => {
  await log.step('Découverte du service GBFS')
  await log.info(`Fichier de découverte : ${url}`)

  const raw = await fetchJson(url, axios, 'gbfs.json')
  const version = readDocument(raw, 'gbfs.json').version
  const feedUrls = discoverFeeds(raw, language)

  const names = Object.keys(feedUrls).sort()
  if (!names.length) throw new Error('Le fichier gbfs.json ne déclare aucun flux exploitable.')
  await log.info(`Version GBFS ${version}, flux publiés : ${names.join(', ')}`)
  if (Number(version.split('.')[0]) > 3) {
    await log.warning(`La version ${version} est plus récente que celles connues du traitement (2.x et 3.0) : les données peuvent être incomplètes.`)
  }

  return { version, feedUrls, discovery: raw }
}

/**
 * Fetch the requested feeds, skipping those the service does not publish.
 * A feed that is declared but fails to load stops the run: silently publishing a
 * dataset with a missing half would look like the service is empty.
 */
export const loadFeeds = async (
  service: GbfsService,
  names: string[],
  axios: AxiosInstance,
  log: LogFunctions
): Promise<Record<string, GbfsDocument>> => {
  const documents: Record<string, GbfsDocument> = {}
  for (const name of names) {
    const url = service.feedUrls[name]
    if (!url) continue
    documents[name] = readDocument(await fetchJson(url, axios, name), name)
    await log.debug(`Flux ${name} chargé (généré le ${documents[name].lastUpdated ?? 'date inconnue'})`)
  }
  return documents
}
