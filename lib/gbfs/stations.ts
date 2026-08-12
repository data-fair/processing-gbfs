import type { LogFunctions } from '@data-fair/lib-common-types/processings.js'
import {
  bool,
  isoInstant,
  list,
  localized,
  num,
  numVehiclesAvailableOf,
  numVehiclesDisabledOf,
  text,
  type GbfsDocument
} from './normalize.ts'
import { vehicleTypeLabel, type Reference } from './reference.ts'

/**
 * One row per station, joining station_information (what the station is) with
 * station_status (what is available right now).
 *
 * A station present in one feed and absent from the other is kept: the identity comes
 * from station_information, and a station whose status is missing is published without
 * availability rather than dropped.
 */
export const buildStations = async (
  documents: Record<string, GbfsDocument>,
  reference: Reference,
  language: string | undefined,
  log: LogFunctions
): Promise<Record<string, any>[]> => {
  const stations = documents.station_information?.data?.stations ?? []
  const statuses = new Map<string, any>()
  for (const status of documents.station_status?.data?.stations ?? []) {
    const id = text(status?.station_id)
    if (id) statuses.set(id, status)
  }

  const updatedAt = documents.station_status?.lastUpdated ?? documents.station_information?.lastUpdated
  const rows: Record<string, any>[] = []
  let withoutId = 0
  let withoutStatus = 0

  for (const station of stations) {
    const id = text(station?.station_id)
    if (!id) {
      withoutId++
      continue
    }
    const status = statuses.get(id)
    if (!status) withoutStatus++

    rows.push({
      _id: id,
      station_id: id,
      name: localized(station.name, language),
      short_name: localized(station.short_name, language),
      address: text(station.address),
      post_code: text(station.post_code),
      cross_street: text(station.cross_street),
      lat: num(station.lat),
      lon: num(station.lon),
      capacity: num(station.capacity),
      parking_type: text(station.parking_type),
      is_virtual_station: bool(station.is_virtual_station),
      contact_phone: text(station.contact_phone),
      rental_methods: list(station.rental_methods),
      num_vehicles_available: numVehiclesAvailableOf(status ?? {}),
      num_vehicles_disabled: numVehiclesDisabledOf(status ?? {}),
      num_docks_available: num(status?.num_docks_available),
      num_docks_disabled: num(status?.num_docks_disabled),
      vehicle_types_available: availableByType(status?.vehicle_types_available, reference),
      is_installed: bool(status?.is_installed),
      is_renting: bool(status?.is_renting),
      is_returning: bool(status?.is_returning),
      last_reported: isoInstant(status?.last_reported),
      updated_at: updatedAt
    })
  }

  if (withoutId) await log.warning(`${withoutId} stations sans identifiant ont été ignorées.`)
  if (withoutStatus) await log.warning(`${withoutStatus} stations sont publiées sans disponibilité : elles sont absentes de station_status.`)
  if (!documents.station_status) await log.warning("Le flux station_status n'est pas publié par le service : les stations sont produites sans disponibilité.")

  return rows
}

/** "Renault Twingo (1) ; Renault Zoe (2)" — a flat, readable rendering of the array. */
const availableByType = (available: unknown, reference: Reference): string | undefined => {
  if (!Array.isArray(available) || !available.length) return undefined
  const parts = available.map((entry: any) => {
    const id = text(entry?.vehicle_type_id)
    const count = num(entry?.count)
    const label = vehicleTypeLabel(id ? reference.vehicleTypes.get(id) : undefined) ?? id
    if (!label) return undefined
    return count === undefined ? label : `${label} (${count})`
  }).filter((part): part is string => !!part)
  return parts.length ? parts.join(' ; ') : undefined
}
