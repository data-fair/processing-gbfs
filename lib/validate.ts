/**
 * GBFS validation with gbfs-validator, the reference validator of the GBFS community
 * (https://github.com/MobilityData/gbfs-validator), the one behind
 * https://gbfs-validator.mobilitydata.org.
 *
 * Where the GTFS plugin posts its archive to a transport-validator daemon, this one
 * runs in the processing: nothing is sent to a third party. The price is that the
 * validator refetches the service's files with its own HTTP client, so a validated
 * run downloads the feeds twice. It also offers no way to abort a validation in
 * flight, hence the stop checks around the call rather than inside it.
 */
import GBFS, { type GbfsFileResult, type GbfsSchemaError, type GbfsValidationResult } from 'gbfs-validator'
import type { LogFunctions } from '@data-fair/lib-common-types/processings.js'

export type { GbfsFileResult, GbfsValidationResult }

export interface FileSummary {
  file: string
  required: boolean
  exists: boolean
  errorsCount: number
}

export interface ValidationSummary {
  /** version of gbfs-validator itself, worth logging: the rules move with it */
  validatorVersion?: string
  /** version announced by the service, and the one the validation ran against */
  detectedVersion?: string
  validatedVersion?: string
  /** true when the validator has no schema for the announced version */
  versionUnimplemented: boolean
  errorsCount: number
  files: FileSummary[]
  /**
   * Files the standard makes mandatory that are missing or invalid. A feed with only
   * optional files in error stays exploitable, so only these block an import.
   */
  blockingFiles: string[]
}

/** Run the validator against a discovery URL. */
export const validateFeed = async (url: string, version?: string): Promise<GbfsValidationResult> => {
  return await new GBFS(url, { version: version || null }).validation()
}

/**
 * Flatten the validator's result: one entry per file with its exhaustive error count,
 * and the list of mandatory files that came out missing or invalid.
 *
 * A file published per language carries its errors under `languages` rather than
 * `errors`; `errorsCount` is already the total across languages either way.
 */
export const summarize = (result: GbfsValidationResult): ValidationSummary => {
  const files: FileSummary[] = (result.files ?? []).map(file => ({
    file: file.file ?? '?',
    required: !!file.required,
    exists: !!file.exists,
    errorsCount: file.errorsCount ?? 0
  }))
  return {
    validatorVersion: result.summary?.validatorVersion,
    detectedVersion: result.summary?.version?.detected,
    validatedVersion: result.summary?.version?.validated,
    versionUnimplemented: !!result.summary?.versionUnimplemented,
    errorsCount: result.summary?.errorsCount ?? files.reduce((total, file) => total + file.errorsCount, 0),
    files,
    blockingFiles: files.filter(file => file.required && (!file.exists || file.errorsCount > 0)).map(file => file.file)
  }
}

/** The Ajv errors of a file, whichever shape the validator used for it. */
const errorsOf = (file: GbfsFileResult): { error: GbfsSchemaError, lang?: string }[] => {
  if (file.errors?.length) return file.errors.map(error => ({ error }))
  return (file.languages ?? []).flatMap(language => (language.errors ?? []).map(error => ({ error, lang: language.lang })))
}

/**
 * Write the validation result to the run's log: one line per file in error with its
 * exhaustive count, then the first anomalies of each in detail. `maxIssues` caps the
 * detail only, so the counts stay true whatever the limit.
 */
export const logValidation = async (
  result: GbfsValidationResult,
  summary: ValidationSummary,
  maxIssues: number,
  log: LogFunctions
) => {
  const validator = summary.validatorVersion ? ` (gbfs-validator ${summary.validatorVersion})` : ''

  if (summary.versionUnimplemented) {
    await log.warning(`Le validateur ne connaît pas la version annoncée par ce service${validator} : la validation est passée.`)
    return
  }

  if (summary.detectedVersion && summary.detectedVersion !== summary.validatedVersion) {
    await log.info(`Version détectée ${summary.detectedVersion}, validée contre la ${summary.validatedVersion}${validator}.`)
  } else {
    await log.info(`Version GBFS ${summary.detectedVersion ?? '?'}${validator}`)
  }

  const missing = summary.files.filter(file => !file.exists)
  if (missing.length) {
    await log.info(`Fichiers absents : ${missing.map(file => `${file.file}${file.required ? ' (obligatoire)' : ''}`).join(', ')}`)
  }

  if (!summary.errorsCount) {
    await log.info('Aucune anomalie détectée.')
    return
  }
  await log.info(`Anomalies détectées : ${summary.errorsCount} sur ${summary.files.filter(file => file.errorsCount).length} fichier(s)`)

  // mandatory files first, then the noisiest: what a publisher has to fix comes on top
  const inError = (result.files ?? [])
    .filter(file => (file.errorsCount ?? 0) > 0)
    .sort((a, b) => (Number(!!b.required) - Number(!!a.required)) || ((b.errorsCount ?? 0) - (a.errorsCount ?? 0)))

  for (const file of inError) {
    const label = `${file.file ?? '?'}${file.required ? ' (obligatoire)' : ''}`
    await log.info(`${label} : ${file.errorsCount} anomalie(s)`)
    const errors = errorsOf(file)
    for (const { error, lang } of errors.slice(0, maxIssues)) {
      const where = [lang && `[${lang}]`, error.instancePath || undefined].filter(Boolean).join(' ')
      await log.debug(`${file.file ?? '?'}${where ? ` ${where}` : ''} : ${error.message ?? 'anomalie'}`)
    }
    if (errors.length > maxIssues) {
      await log.debug(`${file.file ?? '?'} : ${errors.length - maxIssues} anomalie(s) supplémentaires non détaillées.`)
    }
  }
}
