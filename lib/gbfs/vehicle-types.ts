import type { LogFunctions } from '@data-fair/lib-common-types/processings.js'
import { localized, num, text, type GbfsDocument } from './normalize.ts'
import type { Reference } from './reference.ts'

/** One row per model of vehicle the service operates. */
export const buildVehicleTypes = async (
  documents: Record<string, GbfsDocument>,
  reference: Reference,
  language: string | undefined,
  log: LogFunctions
): Promise<Record<string, any>[]> => {
  const types = documents.vehicle_types?.data?.vehicle_types ?? []
  const updatedAt = documents.vehicle_types?.lastUpdated
  const rows: Record<string, any>[] = []
  let withoutId = 0

  for (const type of types) {
    const id = text(type?.vehicle_type_id)
    if (!id) {
      withoutId++
      continue
    }
    const planId = text(type.default_pricing_plan_id)
    rows.push({
      _id: id,
      vehicle_type_id: id,
      name: localized(type.name, language),
      form_factor: text(type.form_factor),
      propulsion_type: text(type.propulsion_type),
      make: localized(type.make, language),
      model: localized(type.model, language),
      // 0 is what operators publish for a vehicle whose range is not metered
      max_range_meters: num(type.max_range_meters),
      wheel_count: num(type.wheel_count),
      rider_capacity: num(type.rider_capacity),
      cargo_volume_capacity: num(type.cargo_volume_capacity),
      cargo_load_capacity: num(type.cargo_load_capacity),
      return_constraint: text(type.return_constraint),
      default_pricing_plan_id: planId,
      default_pricing_plan_name: planId ? reference.pricingPlans.get(planId) : undefined,
      updated_at: updatedAt
    })
  }

  if (withoutId) await log.warning(`${withoutId} types de véhicules sans identifiant ont été ignorés.`)
  return rows
}
