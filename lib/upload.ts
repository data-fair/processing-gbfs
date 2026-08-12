import type { AxiosInstance } from 'axios'
import type { LogFunctions } from '@data-fair/lib-common-types/processings.js'
import path from 'node:path'
import util from 'node:util'
import fs from 'fs-extra'
import FormData from 'form-data'
import { REFRESHABLE_PROPS, RESOURCE_TITLES, type DataResourceKey, type ResourceKey, type SchemaProperty } from './schemas.ts'

export interface DatasetRef {
  key: ResourceKey
  id: string
  title: string
}

/** Lines are sent in batches so a service with many vehicles does not build one huge request. */
const BATCH_SIZE = 1000

/** Axios hides the reason given by data-fair inside response.data; JSON.stringify(err) drops it. */
export const describeError = (err: any) => {
  const detail = err.response?.data
  const body = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : ''
  return body ? `${err.message} : ${body}` : err.message
}

/**
 * The metadata dataset is the head of the family, not one of its members: it carries
 * the service's own name, and the data datasets hang off it with their role appended.
 */
export const datasetTitle = (baseTitle: string, key: ResourceKey) =>
  key === 'system' ? baseTitle : `${baseTitle} - ${RESOURCE_TITLES[key]}`

export const createMetadataDataset = async (
  axios: AxiosInstance,
  title: string,
  description: string | undefined,
  processingId: string,
  log: LogFunctions
): Promise<DatasetRef> => {
  // the description is set here and never again: on later runs it belongs to whoever
  // publishes the data, and rewriting it would silently destroy their edits
  const dataset = (await axios.post('api/v1/datasets', {
    title,
    description,
    isMetaOnly: true,
    extras: { processingId }
  })).data
  await log.info(`Jeu de données créé : ${dataset.title} (${dataset.id})`)
  return { key: 'system', id: dataset.id, title: dataset.title }
}

export const createDataDataset = async (
  axios: AxiosInstance,
  key: DataResourceKey,
  title: string,
  schema: SchemaProperty[],
  origin: string,
  processingId: string,
  log: LogFunctions
): Promise<DatasetRef> => {
  const dataset = (await axios.post('api/v1/datasets', {
    title,
    isRest: true,
    schema,
    origin,
    extras: { processingId }
  })).data
  await log.info(`Jeu de données créé : ${dataset.title} (${dataset.id})`)
  return { key, id: dataset.id, title: dataset.title }
}

export const assertDatasetExists = async (axios: AxiosInstance, ref: DatasetRef) => {
  try {
    return (await axios.get(`api/v1/datasets/${ref.id}`)).data
  } catch (err: any) {
    if (err.response?.status === 404) {
      throw new Error(`Le jeu de données "${RESOURCE_TITLES[ref.key]}" est introuvable (id="${ref.id}"). Corrigez la configuration : il ne sera pas recréé automatiquement, pour ne pas produire de doublon.`)
    }
    throw new Error(describeError(err))
  }
}

/**
 * Refresh only the properties data-fair treats as innocuous. Types, concepts and any
 * x-transform patch applied by hand on the dataset are left as they are: replacing the
 * whole schema would wipe them without a word.
 *
 * Properties the dataset does not have yet — a column the service started publishing,
 * or one this plugin learned to read — are added, otherwise their values would be
 * rejected by data-fair on the next batch.
 */
export const refreshSchema = async (
  axios: AxiosInstance,
  ref: DatasetRef,
  wanted: SchemaProperty[],
  live: any,
  log: LogFunctions
) => {
  const liveSchema: SchemaProperty[] = (live.schema ?? []).filter((property: any) => !property['x-calculated'])
  const liveKeys = new Set(liveSchema.map(property => property.key))
  const wantedByKey = new Map(wanted.map(property => [property.key, property]))
  const concepts: string[] = []
  let changed = false

  const merged: SchemaProperty[] = liveSchema.map((property: any) => {
    const target = wantedByKey.get(property.key)
    if (!target) return property
    const next = { ...property }
    for (const prop of REFRESHABLE_PROPS) {
      const value = (target as any)[prop]
      if (value === undefined) continue
      if (JSON.stringify(next[prop]) !== JSON.stringify(value)) {
        next[prop] = value
        changed = true
      }
    }
    // the concept is posed once, on a column that carries none: one set by hand from a
    // private vocabulary is a deliberate choice and must win over the one suggested here
    if (target['x-refersTo'] && !next['x-refersTo']) {
      next['x-refersTo'] = target['x-refersTo']
      concepts.push(next.key)
      changed = true
    }
    return next
  })

  const added = wanted.filter(property => !liveKeys.has(property.key))
  if (added.length) {
    merged.push(...added)
    changed = true
    await log.info(`Nouvelles colonnes ajoutées à "${ref.title}" : ${added.map(property => property.key).join(', ')}`)
  }

  if (!changed) return
  // adding a concept is not an innocuous schema change for data-fair: it re-finalizes
  // the dataset. It only happens on the run that introduces it.
  if (concepts.length) await log.info(`Concepts posés sur "${ref.title}" : ${concepts.join(', ')}`)
  await log.info(`Mise à jour du schéma de "${ref.title}"`)
  try {
    await axios.patch(`api/v1/datasets/${ref.id}`, { schema: merged })
  } catch (err: any) {
    throw new Error(`Échec de la mise à jour du schéma de "${ref.title}" : ${describeError(err)}`)
  }
}

/**
 * Replace the whole content of a REST dataset with the state read from the service.
 *
 * The first batch carries `drop=true`, which empties the dataset before inserting: a
 * station that disappeared from the service must disappear from the dataset too. An
 * empty set of rows still goes through, so the dataset ends up empty rather than
 * keeping a stale state.
 */
export const replaceLines = async (
  axios: AxiosInstance,
  ref: DatasetRef,
  rows: Record<string, any>[],
  log: LogFunctions
) => {
  await log.info(`Mise à jour de "${ref.title}" : ${rows.length} lignes`)
  const batches: Record<string, any>[][] = []
  for (let i = 0; i < rows.length; i += BATCH_SIZE) batches.push(rows.slice(i, i + BATCH_SIZE))
  if (!batches.length) batches.push([])

  for (const [index, batch] of batches.entries()) {
    // only the first batch drops, the following ones append to what it inserted
    const url = `api/v1/datasets/${ref.id}/_bulk_lines${index === 0 ? '?drop=true' : ''}`
    let summary: any
    try {
      summary = (await axios.post(url, batch)).data
    } catch (err: any) {
      throw new Error(`Échec de l'envoi des données vers "${ref.title}" : ${describeError(err)}`)
    }

    // _bulk_lines decides its status code when it flushes its first batch, so a failure
    // happening later still answers 200: the summary is the only reliable signal
    for (const error of (summary?.errors ?? []).slice(0, 10)) {
      await log.error(`ligne ${error.line} : ${error.error}`)
    }
    if (summary?.cancelled) {
      throw new Error(`Envoi vers "${ref.title}" annulé par Data Fair (${summary.nbErrors} lignes en erreur).`)
    }
    if (summary?.nbErrors) {
      throw new Error(`${summary.nbErrors} lignes en erreur lors de l'envoi vers "${ref.title}".`)
    }
  }
}

const sendForm = async (axios: AxiosInstance, url: string, formData: FormData) => {
  const getLength = util.promisify(formData.getLength).bind(formData)
  const contentLength = await getLength()
  return await axios({
    method: 'post',
    url,
    data: formData,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    headers: { ...formData.getHeaders(), 'content-length': contentLength }
  })
}

export const uploadAttachments = async (axios: AxiosInstance, ref: DatasetRef, files: string[], log: LogFunctions) => {
  for (const filePath of files) {
    const name = path.basename(filePath)
    await log.info(`Chargement de la pièce jointe ${name}`)
    try {
      const formData = new FormData()
      formData.append('attachment', fs.createReadStream(filePath), { filename: name })
      const response = await sendForm(axios, `api/v1/datasets/${ref.id}/metadata-attachments`, formData)

      const dataset = (await axios.get(`api/v1/datasets/${ref.id}`)).data
      const attachments = dataset.attachments ?? []
      const index = attachments.findIndex((attachment: any) => attachment.name === response.data.name)
      const previous = index >= 0 ? attachments.splice(index, 1).pop() : {}
      attachments.push({
        ...previous,
        type: 'file',
        name: response.data.name,
        size: response.data.size,
        mimetype: response.data.mimetype,
        updatedAt: response.data.updatedAt,
        title: name
      })
      await axios.patch(`api/v1/datasets/${ref.id}`, { attachments })
    } catch (err: any) {
      throw new Error(`Échec du chargement de la pièce jointe ${name} : ${describeError(err)}`)
    }
  }
}

/**
 * Point every produced dataset at its siblings.
 *
 * The title stored in a link is a snapshot: it does not follow a rename, a move to the
 * trash or a deletion, and data-fair says nothing. Rewriting the family links on every
 * run keeps them honest. Links the user added towards other datasets are preserved.
 */
export const syncRelatedDatasets = async (axios: AxiosInstance, refs: DatasetRef[], log: LogFunctions) => {
  if (refs.length < 2) return
  const familyIds = new Set(refs.map(ref => ref.id))
  for (const ref of refs) {
    const siblings = refs.filter(other => other.id !== ref.id).map(other => ({ id: other.id, title: other.title }))
    try {
      const dataset = (await axios.get(`api/v1/datasets/${ref.id}`)).data
      const foreign = (dataset.relatedDatasets ?? []).filter((related: any) => !familyIds.has(related.id))
      const related = [...foreign, ...siblings]
      const current = dataset.relatedDatasets ?? []
      if (JSON.stringify(current) === JSON.stringify(related)) continue
      await axios.patch(`api/v1/datasets/${ref.id}`, { relatedDatasets: related })
    } catch (err: any) {
      throw new Error(`Échec de la mise à jour des jeux liés de "${ref.title}" : ${describeError(err)}`)
    }
  }
  await log.info(`Jeux liés mis à jour sur ${refs.length} jeux de données`)
}
