import type { LogFunctions } from '@data-fair/lib-common-types/processings.js'
import { bool, geometry, isoInstant, list, localized, num, type GbfsDocument } from './normalize.ts'

/**
 * One row per zone and per rule.
 *
 * A zone may carry several rules, each targeting different vehicle types, and a rule
 * only makes sense next to the vehicles it applies to. A zone without a rule falls back
 * to the service's global rules, which is exactly what the specification says applies.
 *
 * Zones have no identifier in the specification, so the row id is derived from the
 * position in the feed. That is stable enough here: every run replaces the whole dataset.
 */
export const buildGeofencingZones = async (
  documents: Record<string, GbfsDocument>,
  language: string | undefined,
  log: LogFunctions
): Promise<Record<string, any>[]> => {
  const document = documents.geofencing_zones
  const features = document?.data?.geofencing_zones?.features ?? []
  const globalRules = document?.data?.global_rules
  const updatedAt = document?.lastUpdated
  const rows: Record<string, any>[] = []
  let withoutGeometry = 0

  features.forEach((feature: any, index: number) => {
    const geo = geometry(feature?.geometry)
    if (!geo) {
      withoutGeometry++
      return
    }
    const properties = feature.properties ?? {}
    const rules: any[] = Array.isArray(properties.rules) && properties.rules.length
      ? properties.rules
      : (Array.isArray(globalRules) && globalRules.length ? globalRules : [{}])

    rules.forEach((rule: any, ruleIndex: number) => {
      rows.push({
        _id: rules.length > 1 ? `zone-${index}-${ruleIndex}` : `zone-${index}`,
        geometry: geo,
        name: localized(properties.name, language),
        start: isoInstant(properties.start),
        end: isoInstant(properties.end),
        vehicle_type_ids: list(rule?.vehicle_type_ids),
        // 2.x said ride_allowed for what 3.0 splits into start and end
        ride_start_allowed: bool(rule?.ride_start_allowed ?? rule?.ride_allowed),
        ride_end_allowed: bool(rule?.ride_end_allowed ?? rule?.ride_allowed),
        ride_through_allowed: bool(rule?.ride_through_allowed),
        maximum_speed_kph: num(rule?.maximum_speed_kph),
        station_parking: bool(rule?.station_parking),
        updated_at: updatedAt
      })
    })
  })

  if (withoutGeometry) await log.warning(`${withoutGeometry} zones sans géométrie ont été ignorées.`)
  if (!rows.length) await log.warning('Le service ne publie aucune zone de circulation : le jeu de données est produit vide.')

  return rows
}
