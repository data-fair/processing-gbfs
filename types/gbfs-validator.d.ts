/**
 * Ambient declaration for gbfs-validator, which ships no types of its own.
 *
 * Only what lib/validate.ts reads is described here, and every key is optional:
 * the validator's result shape varies with the GBFS version (a 2.x feed publishes
 * one file per language, a 3.0 feed a single one) and unknown keys are ignored.
 */
declare module 'gbfs-validator' {
  /** One Ajv error, as produced by the JSON schemas the validator is built on. */
  export interface GbfsSchemaError {
    instancePath?: string
    schemaPath?: string
    keyword?: string
    message?: string
    params?: Record<string, any>
  }

  /** The validation of one file, in one language for a multilingual 2.x feed. */
  export interface GbfsLanguageResult {
    lang?: string
    url?: string
    exists?: boolean
    errors?: GbfsSchemaError[] | null
  }

  /** The validation of one file of the feed. */
  export interface GbfsFileResult {
    file?: string
    url?: string
    required?: boolean
    recommended?: boolean
    exists?: boolean
    hasErrors?: boolean
    /** exhaustive, even when only the first errors are detailed */
    errorsCount?: number
    errors?: GbfsSchemaError[] | null
    /** set instead of `errors` when the feed publishes the file per language */
    languages?: GbfsLanguageResult[]
  }

  export interface GbfsValidationResult {
    summary: {
      validatorVersion?: string
      version?: { detected?: string, validated?: string }
      hasErrors?: boolean
      errorsCount?: number
      /** the only key set when the validator has no schema for the version announced */
      versionUnimplemented?: boolean
      gbfsVersion?: string | null
    }
    /** absent when the version is unimplemented */
    files?: GbfsFileResult[]
  }

  export interface GbfsValidatorOptions {
    docked?: boolean
    freefloating?: boolean
    /** forces the spec version to validate against, instead of the announced one */
    version?: string | null
  }

  export default class GBFS {
    constructor (url: string, options?: GbfsValidatorOptions)
    validation (): Promise<GbfsValidationResult>
  }
}
