import type { LogFunctions } from '@data-fair/lib-common-types/processings.js'
import {
  bool,
  isoInstant,
  list,
  num,
  text,
  vehicleIdOf,
  vehiclesOf,
  type GbfsDocument
} from './normalize.ts'
import { vehicleTypeLabel, type Reference } from './reference.ts'

/**
 * One row per vehicle currently published by the service, with its type and its
 * pricing plan resolved to names.
 *
 * The feed only lists vehicles available for rent: a vehicle disappearing from one run
 * to the next means it has been taken, not that it no longer exists.
 */
export const buildVehicles = async (
  documents: Record<string, GbfsDocument>,
  reference: Reference,
  language: string | undefined,
  log: LogFunctions
): Promise<Record<string, any>[]> => {
  const vehicles = vehiclesOf(documents.vehicle_status?.data)
  const updatedAt = documents.vehicle_status?.lastUpdated
  const rows: Record<string, any>[] = []
  let withoutId = 0
  let withoutPosition = 0

  for (const vehicle of vehicles) {
    const id = vehicleIdOf(vehicle)
    if (!id) {
      withoutId++
      continue
    }

    const typeId = text(vehicle.vehicle_type_id)
    const type = typeId ? reference.vehicleTypes.get(typeId) : undefined
    const planId = text(vehicle.pricing_plan_id) ?? type?.defaultPricingPlanId

    const lat = num(vehicle.lat)
    const lon = num(vehicle.lon)
    // a vehicle parked in a station may legitimately omit its position
    if (lat === undefined || lon === undefined) withoutPosition++

    rows.push({
      _id: id,
      vehicle_id: id,
      lat,
      lon,
      station_id: text(vehicle.station_id),
      home_station_id: text(vehicle.home_station_id),
      vehicle_type_id: typeId,
      vehicle_type_name: vehicleTypeLabel(type),
      form_factor: type?.formFactor,
      propulsion_type: type?.propulsionType,
      make: type?.make,
      model: type?.model,
      current_range_meters: num(vehicle.current_range_meters),
      current_fuel_percent: num(vehicle.current_fuel_percent),
      is_reserved: bool(vehicle.is_reserved),
      is_disabled: bool(vehicle.is_disabled),
      pricing_plan_id: planId,
      pricing_plan_name: planId ? reference.pricingPlans.get(planId) : undefined,
      vehicle_equipment: list(vehicle.vehicle_equipment),
      available_until: isoInstant(vehicle.available_until),
      last_reported: isoInstant(vehicle.last_reported),
      updated_at: updatedAt
    })
  }

  if (withoutId) await log.warning(`${withoutId} véhicules sans identifiant ont été ignorés.`)
  if (withoutPosition) await log.info(`${withoutPosition} véhicules sont publiés sans position : ils sont stationnés dans une station.`)
  if (!documents.vehicle_types) await log.warning("Le flux vehicle_types n'est pas publié par le service : les véhicules sont produits sans modèle ni motorisation.")

  return rows
}
