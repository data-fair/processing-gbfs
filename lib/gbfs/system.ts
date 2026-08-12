import { localized, text, type GbfsDocument } from './normalize.ts'

/**
 * A human-readable summary of system_information, used as the description of the
 * metadata dataset.
 *
 * Applied on creation only: the description belongs to whoever publishes the data, and
 * rewriting it on every run would silently destroy their edits.
 */
export const buildSystemDescription = (
  documents: Record<string, GbfsDocument>,
  version: string,
  language?: string
): string | undefined => {
  const data = documents.system_information?.data
  if (!data) return undefined

  const name = localized(data.name, language)
  const operator = localized(data.operator, language)
  const lines: string[] = []

  if (name) lines.push(operator ? `Données du service ${name}, exploité par ${operator}.` : `Données du service ${name}.`)
  else if (operator) lines.push(`Données du service exploité par ${operator}.`)

  const details: [string, string | undefined][] = [
    ['Identifiant du service', text(data.system_id)],
    ['Site', text(data.url)],
    ['Téléphone', text(data.phone_number)],
    ['Courriel', text(data.email)],
    ['Fuseau horaire', text(data.timezone)],
    ["Horaires d'ouverture", text(data.opening_hours)],
    ['Licence', text(data.license_id) ?? text(data.license_url)],
    ['Conditions générales', localized(data.terms_url, language)],
    ['Politique de confidentialité', localized(data.privacy_url, language)]
  ]
  const rendered = details.filter(([, value]) => !!value).map(([label, value]) => `- ${label} : ${value}`)
  if (rendered.length) lines.push('', ...rendered)

  lines.push('', `Publié au format GBFS ${version}.`)
  return lines.join('\n')
}

/** Title suggested by the feed itself, used when the user leaves the base title empty. */
export const systemTitle = (documents: Record<string, GbfsDocument>, language?: string): string | undefined =>
  localized(documents.system_information?.data?.name, language) ??
  text(documents.system_information?.data?.system_id)
