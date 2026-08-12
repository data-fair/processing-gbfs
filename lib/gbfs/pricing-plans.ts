import type { LogFunctions } from '@data-fair/lib-common-types/processings.js'
import { bool, list, localized, num, text, type GbfsDocument } from './normalize.ts'

/**
 * Render a per-distance or per-time pricing table as one readable sentence.
 *
 * The tables run to twenty steps on some operators, and a JSON blob in a column is
 * unreadable. `interval: 0` is the specification's way of saying the rate is charged
 * once when the segment is entered, not per unit.
 */
export const formatPricingSegments = (segments: unknown, unit: string, currency?: string): string | undefined => {
  if (!Array.isArray(segments) || !segments.length) return undefined
  const suffix = currency ? ` ${currency}` : ' €'

  const parts = segments.map((segment: any) => {
    const rate = num(segment?.rate)
    if (rate === undefined) return undefined
    const start = num(segment?.start) ?? 0
    const end = num(segment?.end)
    const interval = num(segment?.interval)
    const range = end === undefined ? `au-delà de ${start} ${unit}` : `de ${start} à ${end} ${unit}`
    const price = interval ? `${rate}${suffix} par ${interval} ${unit}` : `${rate}${suffix} (forfait)`
    return `${range} : ${price}`
  }).filter((part): part is string => !!part)

  return parts.length ? parts.join(' ; ') : undefined
}

/** One row per pricing plan declared by the service. */
export const buildPricingPlans = async (
  documents: Record<string, GbfsDocument>,
  language: string | undefined,
  log: LogFunctions
): Promise<Record<string, any>[]> => {
  const plans = documents.system_pricing_plans?.data?.plans ?? []
  const updatedAt = documents.system_pricing_plans?.lastUpdated
  const rows: Record<string, any>[] = []
  let withoutId = 0

  for (const plan of plans) {
    const id = text(plan?.plan_id)
    if (!id) {
      withoutId++
      continue
    }
    const currency = text(plan.currency)
    rows.push({
      _id: id,
      plan_id: id,
      name: localized(plan.name, language),
      description: localized(plan.description, language),
      url: text(plan.url),
      currency,
      price: num(plan.price),
      is_taxable: bool(plan.is_taxable),
      surge_pricing: bool(plan.surge_pricing),
      per_km_pricing: formatPricingSegments(plan.per_km_pricing, 'km', currency),
      per_min_pricing: formatPricingSegments(plan.per_min_pricing, 'min', currency),
      reservation_price_per_min: num(plan.reservation_price_per_min),
      reservation_price_flat_rate: num(plan.reservation_price_flat_rate),
      vehicle_type_ids: list(plan.vehicle_type_ids),
      updated_at: updatedAt
    })
  }

  if (withoutId) await log.warning(`${withoutId} tarifs sans identifiant ont été ignorés.`)
  return rows
}
