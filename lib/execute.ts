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
import { RESOURCE_FEEDS, RESOURCE_KEYS, RESOURCE_LOG_NAMES, buildSchemas, type DataResourceKey, type ResourceKey } from './schemas.ts'
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
  if (shouldBeStopped) throw new Error('Processing interrupted')
}

/** Kept in RESOURCE_KEYS order whatever order the form wrote the selection in. */
export const wantedFromResources = (resources: any): ResourceKey[] => {
  const selected: string[] = Array.isArray(resources) ? resources : []
  return RESOURCE_KEYS.filter(key => selected.includes(key))
}

/**
 * One entry per role, kept in RESOURCE_KEYS order and roles without a dataset left out.
 *
 * `[{ resource, dataset: { id, title } }]` is the shape the platform reads to list the
 * datasets a processing feeds: processings looks for a `dataset` object, either at the
 * root of the configuration or inside each entry of a `datasets` array.
 */
export const refsFromConfig = (datasets: any): DatasetRef[] => {
  const entries: any[] = Array.isArray(datasets) ? datasets : []
  const byKey: Record<string, any> = Object.fromEntries(entries.map(entry => [entry?.resource, entry?.dataset]))
  const refs: DatasetRef[] = []
  for (const key of RESOURCE_KEYS) {
    const dataset = byKey[key]
    if (!dataset?.id) continue
    refs.push({ key, id: dataset.id, title: dataset.title || dataset.id })
  }
  return refs
}

/**
 * One line per role, the dataset filled only for the roles actually produced.
 *
 * The form neither adds nor removes lines: the configuration carries them all, and a
 * line left without a dataset is a role this processing does not produce.
 */
export const datasetsFromRefs = (refs: DatasetRef[]) => {
  const byKey = Object.fromEntries(refs.map(ref => [ref.key, { id: ref.id, title: ref.title }]))
  return RESOURCE_KEYS.map(key => byKey[key] ? { resource: key, dataset: byKey[key] } : { resource: key })
}

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
    // feed names come from the remote gbfs.json: never let one escape the directory
    const file = path.join(dir, `${path.basename(name)}.json`)
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
    await log.step('GBFS validation')
    // gbfs-validator offers no abort signal, so an interruption is only honoured
    // on either side of the call; it takes about a second on a typical service
    const result = await validateFeed(config.url)
    throwIfStopped()

    const summary = summarize(result)
    await logValidation(result, summary, maxIssues, log)

    if (mode === 'validate') {
      if (summary.blockingFiles.length) {
        throw new Error(`The GBFS feed is not usable, blocking issues in: ${summary.blockingFiles.join(', ')}`)
      }
      await log.info('Validation done')
      return
    }
    if (config.failOnError && summary.blockingFiles.length) {
      throw new Error(`The feed has blocking issues in ${summary.blockingFiles.join(', ')}: import stopped (the "fail if the feed contains issues" option is on)`)
    }
  }

  const create = config.datasetMode === 'create'
  const configuredRefs = create ? [] : refsFromConfig(config.datasets)
  const requested = create ? wantedFromResources(config.resources) : configuredRefs.map(ref => ref.key)
  if (!requested.length) {
    throw new Error(create
      ? 'No dataset to produce: select at least one'
      : 'No dataset to update: fill in at least one line')
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
    await log.warning(`The service does not publish the ${RESOURCE_FEEDS[key].required} feed: the ${RESOURCE_LOG_NAMES[key]} dataset is not produced`)
  }
  if (!wanted.length) throw new Error('None of the requested datasets can be produced from the feeds this service publishes')

  await log.step('Reading the feeds')
  await log.info(`Datasets to produce: ${wanted.map(key => RESOURCE_LOG_NAMES[key]).join(', ')}`)
  const documents = await loadFeeds(service, feedsFor(wanted, Object.keys(service.feedUrls)), axios, log)
  throwIfStopped()

  const reference = buildReference(documents, language)
  const dataKeys = wanted.filter((key): key is DataResourceKey => key !== 'system')
  const produced = new Map<DataResourceKey, Record<string, any>[]>()
  for (const key of dataKeys) {
    throwIfStopped()
    const rows = await buildRows(key, documents, reference, language, log)
    await log.info(`${RESOURCE_LOG_NAMES[key]}: ${rows.length} line(s)`)
    produced.set(key, rows)
  }
  throwIfStopped()

  const schemas = buildSchemas()
  const refs: DatasetRef[] = []

  if (create) {
    await log.step('Creating the datasets')
    const base = baseTitle(config.datasetTitle, documents, language)
    await log.info(`Base title of the datasets: ${base}`)
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
    await log.step('Checking the datasets')
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

  await log.step('Sending the data')
  for (const ref of refs) {
    throwIfStopped()
    const rows = ref.key === 'system' ? undefined : produced.get(ref.key)
    if (rows) await replaceLines(axios, ref, rows, log)
  }
  throwIfStopped()

  const systemRef = refs.find(ref => ref.key === 'system')
  if (systemRef) {
    await log.step('Attachments')
    const files = await writeAttachments(service.discovery, documents, tmpDir)
    await uploadAttachments(axios, systemRef, files, log)
  }
  throwIfStopped()

  await log.step('Related datasets')
  await syncRelatedDatasets(axios, refs, log)

  // no cleanup here: the worker creates tmpDir per run and removes it in a finally
  await log.info('Processing done')
}
