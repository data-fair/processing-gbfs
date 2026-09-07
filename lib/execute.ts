import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'
import path from 'node:path'
import fs from 'fs-extra'
import { discover, loadFeeds } from './gbfs/fetch.ts'
import type { GbfsDocument } from './gbfs/normalize.ts'
import { buildReference } from './gbfs/reference.ts'
import { buildStations } from './gbfs/stations.ts'
import { buildVehicles } from './gbfs/vehicles.ts'
import { buildVehicleTypes } from './gbfs/vehicle-types.ts'
import { buildPricingPlans } from './gbfs/pricing-plans.ts'
import { buildGeofencingZones } from './gbfs/geofencing-zones.ts'
import { baseTitle, buildSystemDescription } from './gbfs/system.ts'
import { logValidation, summarize, validateFeed } from './validate.ts'
import { RESOURCE_FEEDS, RESOURCE_KEYS, RESOURCE_TITLES, buildSchemas, type DataResourceKey, type ResourceKey } from './schemas.ts'
import {
  assertDatasetExists,
  createDataDataset,
  createMetadataDataset,
  datasetTitle,
  refreshSchema,
  replaceLines,
  syncRelatedDatasets,
  uploadAttachments,
  type DatasetRef
} from './upload.ts'

let shouldBeStopped = false

export const stop = async () => { shouldBeStopped = true }

const throwIfStopped = () => {
  if (shouldBeStopped) throw new Error('Traitement interrompu.')
}

/** Kept in RESOURCE_KEYS order whatever order the form wrote the selection in. */
export const wantedFromResources = (resources: any): ResourceKey[] => {
  if (Array.isArray(resources)) return RESOURCE_KEYS.filter(key => resources.includes(key))
  // configurations written before the list became a multi-select carry an object of booleans
  return RESOURCE_KEYS.filter(key => !!resources?.[key])
}

/**
 * One entry per role, empty roles left out; the config object is unordered, RESOURCE_KEYS is not.
 *
 * The array of `{ key, id, title }` written before the roles became named properties is
 * still read: the plugin has never been released, but a configuration may exist on a
 * staging instance, and the first run rewrites it through patchConfig.
 */
const refsFromConfig = (datasets: any): DatasetRef[] => {
  const byKey = Array.isArray(datasets)
    ? Object.fromEntries(datasets.map((entry: any) => [entry?.key, entry]))
    : datasets
  const refs: DatasetRef[] = []
  for (const key of RESOURCE_KEYS) {
    const entry = byKey?.[key]
    if (!entry?.id) continue
    refs.push({ key, id: entry.id, title: entry.title || entry.id })
  }
  return refs
}

const datasetsFromRefs = (refs: DatasetRef[]) =>
  Object.fromEntries(refs.map(ref => [ref.key, { id: ref.id, title: ref.title }]))

/** The feeds that must be fetched to produce the requested resources. */
const feedsFor = (wanted: ResourceKey[], allFeeds: string[]): string[] => {
  // the metadata dataset carries every feed the service publishes as an attachment
  if (wanted.includes('system')) return allFeeds
  const names = new Set<string>()
  for (const key of wanted) {
    if (key === 'system') continue
    const feeds = RESOURCE_FEEDS[key]
    names.add(feeds.required)
    for (const optional of feeds.optional) names.add(optional)
  }
  return [...names]
}

const buildRows = async (
  key: DataResourceKey,
  documents: Record<string, GbfsDocument>,
  reference: ReturnType<typeof buildReference>,
  language: string | undefined,
  log: ProcessingContext['log']
): Promise<Record<string, any>[]> => {
  if (key === 'stations') return await buildStations(documents, reference, language, log)
  if (key === 'vehicles') return await buildVehicles(documents, reference, language, log)
  if (key === 'vehicle-types') return await buildVehicleTypes(documents, reference, language, log)
  if (key === 'pricing-plans') return await buildPricingPlans(documents, language, log)
  return await buildGeofencingZones(documents, language, log)
}

/** Write every feed read this run next to each other, so they can be attached as-is. */
const writeAttachments = async (
  discovery: any,
  documents: Record<string, GbfsDocument>,
  tmpDir: string
): Promise<string[]> => {
  const dir = path.join(tmpDir, 'gbfs')
  await fs.ensureDir(dir)
  const files: string[] = []
  const write = async (name: string, content: any) => {
    const file = path.join(dir, `${name}.json`)
    await fs.writeFile(file, JSON.stringify(content, null, 2))
    files.push(file)
  }
  await write('gbfs', discovery)
  for (const name of Object.keys(documents).sort()) {
    if (name === 'gbfs') continue
    await write(name, documents[name].raw)
  }
  return files
}

export const run = async (context: ProcessingContext<ProcessingConfig>) => {
  shouldBeStopped = false
  const { processingConfig, processingId, tmpDir, axios, log, patchConfig } = context
  const config = processingConfig as any
  const language: string | undefined = config.language || undefined

  const mode = config.mode ?? 'import'
  const maxIssues = config.maxIssues ?? 20

  // validate mode: the summary is the whole result, nothing else is produced.
  // import mode: the validation is optional and, with failOnError, blocks the import.
  if (mode === 'validate' || config.validationEnabled !== false) {
    await log.step('Validation GBFS')
    // gbfs-validator offers no abort signal, so an interruption is only honoured
    // on either side of the call; it takes about a second on a typical service
    const result = await validateFeed(config.url)
    throwIfStopped()

    const summary = summarize(result)
    await logValidation(result, summary, maxIssues, log)

    if (mode === 'validate') {
      if (summary.blockingFiles.length) {
        throw new Error(`Flux GBFS inexploitable : ${summary.blockingFiles.join(', ')}.`)
      }
      await log.info('Validation terminée.')
      return
    }
    if (config.failOnError && summary.blockingFiles.length) {
      throw new Error(`Le flux contient des anomalies bloquantes sur ${summary.blockingFiles.join(', ')} : import interrompu (option « échouer sur anomalies » active).`)
    }
  }

  const create = config.datasetMode === 'create'
  const configuredRefs = create ? [] : refsFromConfig(config.datasets)
  const requested = create ? wantedFromResources(config.resources) : configuredRefs.map(ref => ref.key)
  if (!requested.length) {
    throw new Error(create
      ? 'Aucun jeu de données à produire : sélectionnez au moins une donnée.'
      : 'Aucun jeu de données à mettre à jour : renseignez au moins un rôle.')
  }
  if (Array.isArray(config.datasets)) {
    await log.warning('Configuration héritée : la liste des jeux de données est convertie en un jeu par rôle.')
    await patchConfig({ datasetMode: 'update', datasets: datasetsFromRefs(configuredRefs) } as any)
  }

  const service = await discover(config.url, language, axios, log)
  throwIfStopped()

  // a resource whose feed the service does not publish is dropped here rather than
  // producing an empty dataset that would look like the service has nothing to offer
  const wanted: ResourceKey[] = []
  for (const key of requested) {
    if (key === 'system' || service.feedUrls[RESOURCE_FEEDS[key].required]) {
      wanted.push(key)
      continue
    }
    await log.warning(`Le flux ${RESOURCE_FEEDS[key].required} n'est pas publié par le service : les ${RESOURCE_TITLES[key]} ne sont pas produites.`)
  }
  if (!wanted.length) throw new Error('Aucun des jeux de données demandés ne peut être produit à partir des flux publiés par ce service.')

  await log.step('Lecture des flux')
  await log.info(`Jeux de données à produire : ${wanted.map(key => RESOURCE_TITLES[key]).join(', ')}`)
  const documents = await loadFeeds(service, feedsFor(wanted, Object.keys(service.feedUrls)), axios, log)
  throwIfStopped()

  const reference = buildReference(documents, language)
  const dataKeys = wanted.filter((key): key is DataResourceKey => key !== 'system')
  const produced = new Map<DataResourceKey, Record<string, any>[]>()
  for (const key of dataKeys) {
    throwIfStopped()
    const rows = await buildRows(key, documents, reference, language, log)
    await log.info(`${RESOURCE_TITLES[key]} : ${rows.length} lignes`)
    produced.set(key, rows)
  }
  throwIfStopped()

  const schemas = buildSchemas()
  const refs: DatasetRef[] = []

  if (create) {
    await log.step('Création des jeux de données')
    const base = baseTitle(config.datasetTitle, documents, language)
    await log.info(`Titre de base des jeux de données : ${base}`)
    for (const key of wanted) {
      throwIfStopped()
      const title = datasetTitle(base, key)
      if (key === 'system') {
        const description = buildSystemDescription(documents, service.version, language)
        refs.push(await createMetadataDataset(axios, title, description, processingId, log))
      } else {
        refs.push(await createDataDataset(axios, key, title, schemas[key], config.url, processingId, log))
      }
    }
    // recorded before anything else can fail: without this the next run would create
    // a second family of datasets instead of updating this one
    await patchConfig({ datasetMode: 'update', datasets: datasetsFromRefs(refs) } as any)
  } else {
    await log.step('Vérification des jeux de données')
    for (const ref of configuredRefs) {
      throwIfStopped()
      const live = await assertDatasetExists(axios, ref)
      const resolved: DatasetRef = { ...ref, title: live.title || ref.title }
      if (ref.key !== 'system' && produced.has(ref.key)) {
        await refreshSchema(axios, resolved, schemas[ref.key], live, log)
      }
      refs.push(resolved)
    }
  }
  throwIfStopped()

  await log.step('Envoi des données')
  for (const ref of refs) {
    throwIfStopped()
    const rows = ref.key === 'system' ? undefined : produced.get(ref.key)
    if (rows) await replaceLines(axios, ref, rows, log)
  }
  throwIfStopped()

  const systemRef = refs.find(ref => ref.key === 'system')
  if (systemRef) {
    await log.step('Pièces jointes')
    const files = await writeAttachments(service.discovery, documents, tmpDir)
    await uploadAttachments(axios, systemRef, files, log)
  }
  throwIfStopped()

  await log.step('Jeux liés')
  await syncRelatedDatasets(axios, refs, log)

  // no cleanup here: the worker creates tmpDir per run and removes it in a finally
  await log.info('Traitement terminé.')
}
