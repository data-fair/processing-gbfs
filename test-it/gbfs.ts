import { describe, it } from 'node:test'
import assert from 'node:assert'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { LogFunctions } from '@data-fair/lib-common-types/processings.js'
import {
  bool,
  discoverFeeds,
  isoInstant,
  list,
  localized,
  num,
  readDocument,
  vehicleIdOf,
  vehiclesOf,
  type GbfsDocument
} from '../lib/gbfs/normalize.ts'
import { buildReference, vehicleTypeLabel } from '../lib/gbfs/reference.ts'
import { buildStations } from '../lib/gbfs/stations.ts'
import { buildVehicles } from '../lib/gbfs/vehicles.ts'
import { buildVehicleTypes } from '../lib/gbfs/vehicle-types.ts'
import { buildPricingPlans, formatPricingSegments } from '../lib/gbfs/pricing-plans.ts'
import { buildGeofencingZones } from '../lib/gbfs/geofencing-zones.ts'
import { baseTitle, buildSystemDescription, systemTitle } from '../lib/gbfs/system.ts'
import { buildSchemas, RESOURCE_FEEDS, STATION_CONCEPT, VEHICLE_TYPE_CONCEPT } from '../lib/schemas.ts'
import { datasetTitle } from '../lib/upload.ts'
import processingSchema from '../processing-config-schema.json' with { type: 'json' }

const resources = path.join(path.dirname(fileURLToPath(import.meta.url)), 'resources')

const noopLog: LogFunctions = {
  step: async () => {},
  error: async () => {},
  warning: async () => {},
  info: async () => {},
  debug: async () => {},
  task: async () => {},
  progress: async () => {}
}

const readFixture = (version: 'v2' | 'v3', name: string) =>
  JSON.parse(fs.readFileSync(path.join(resources, version, `${name}.json`), 'utf8'))

const loadDocuments = (version: 'v2' | 'v3', names: string[]): Record<string, GbfsDocument> => {
  const documents: Record<string, GbfsDocument> = {}
  for (const name of names) {
    // the 2.x fixtures keep their own file names, the code only knows the 3.0 ones
    const file = version === 'v2' && name === 'vehicle_status' ? 'free_bike_status' : name
    documents[name] = readDocument(readFixture(version, file), name)
  }
  return documents
}

describe('normalisation des versions GBFS', () => {
  it('lit les instants des deux versions', () => {
    assert.equal(isoInstant('2026-08-12T14:47:41.6397328+02:00'), '2026-08-12T12:47:41.639Z')
    assert.equal(isoInstant(1660312061), '2022-08-12T13:47:41.000Z')
    assert.equal(isoInstant('1660312061'), '2022-08-12T13:47:41.000Z')
    assert.equal(isoInstant('pas une date'), undefined)
    assert.equal(isoInstant(undefined), undefined)
    assert.equal(isoInstant(''), undefined)
  })

  it('résout les libellés localisés des deux versions', () => {
    const localizedName = [{ text: 'Gare', language: 'fr' }, { text: 'Station', language: 'en' }]
    assert.equal(localized(localizedName, 'fr'), 'Gare')
    assert.equal(localized(localizedName, 'en'), 'Station')
    // an absent language falls back to the first one published rather than to nothing
    assert.equal(localized(localizedName, 'de'), 'Gare')
    assert.equal(localized(localizedName), 'Gare')
    assert.equal(localized('Gare', 'fr'), 'Gare')
    assert.equal(localized([], 'fr'), undefined)
    assert.equal(localized(undefined), undefined)
  })

  it('lit les booléens publiés en 0/1', () => {
    assert.equal(bool(true), true)
    assert.equal(bool(0), false)
    assert.equal(bool(1), true)
    assert.equal(bool('true'), true)
    assert.equal(bool(undefined), undefined)
    assert.equal(bool('peut-être'), undefined)
  })

  it('lit les nombres et les listes', () => {
    assert.equal(num(0), 0)
    assert.equal(num('12.5'), 12.5)
    assert.equal(num(''), undefined)
    assert.equal(num(null), undefined)
    assert.equal(list(['a', 'b']), 'a;b')
    assert.equal(list([]), undefined)
    assert.equal(list('a'), undefined)
  })

  it('découvre les flux en 3.0', () => {
    const feeds = discoverFeeds(readFixture('v3', 'gbfs'), 'fr')
    assert.equal(feeds.station_information, 'https://backend.citiz.fr/public/provider/9/gbfs/v3.0/station_information.json')
    assert.ok(feeds.vehicle_status)
  })

  it('découvre les flux en 2.x, par langue, et renomme free_bike_status', () => {
    const raw = readFixture('v2', 'gbfs')
    const feeds = discoverFeeds(raw, 'fr')
    assert.equal(feeds.vehicle_status, 'https://example.org/gbfs/v2/free_bike_status.json')
    assert.equal(feeds.free_bike_status, undefined)
    assert.equal(feeds.system_information, 'https://example.org/gbfs/v2/system_information.json')
    // an unpublished language falls back to a published one instead of failing
    assert.ok(discoverFeeds(raw, 'de').system_information)
    assert.equal(discoverFeeds(raw, 'en').system_information, 'https://example.org/gbfs/v2/en/system_information.json')
  })

  it('rejette un document sans data', () => {
    assert.throws(() => readDocument({ version: '3.0' }, 'gbfs.json'), /ne contient pas de propriété "data"/)
    assert.throws(() => discoverFeeds({ version: '3.0' }), /ne contient pas de propriété "data"/)
  })

  it('lit les véhicules sous leurs deux noms', () => {
    assert.equal(vehiclesOf({ bikes: [{ bike_id: 'B-001' }] }).length, 1)
    assert.equal(vehiclesOf({ vehicles: [{ vehicle_id: '1' }] }).length, 1)
    assert.equal(vehiclesOf(undefined).length, 0)
    assert.equal(vehicleIdOf({ bike_id: 'B-001' }), 'B-001')
    assert.equal(vehicleIdOf({ vehicle_id: '1' }), '1')
  })
})

describe('construction des lignes en GBFS 3.0', () => {
  const documents = loadDocuments('v3', ['system_information', 'station_information', 'station_status', 'vehicle_status', 'vehicle_types', 'system_pricing_plans', 'geofencing_zones'])
  const reference = buildReference(documents, 'fr')

  it('joint les stations à leur disponibilité', async () => {
    const rows = await buildStations(documents, reference, 'fr', noopLog)
    // the station without an id is dropped, the one without a status is kept
    assert.equal(rows.length, 3)
    const station = rows.find(row => row.station_id === '547')
    assert.ok(station)
    assert.equal(station._id, '547')
    assert.equal(station.name, 'BUXEROLLES MAIRIE')
    assert.equal(station.address, '10 rue Maurice Ravel 86180 BUXEROLLES')
    assert.equal(station.capacity, 2)
    assert.equal(station.is_virtual_station, false)
    assert.equal(station.num_vehicles_available, 1)
    assert.equal(station.num_docks_available, 0)
    assert.equal(station.is_renting, true)
    assert.equal(typeof station.lat, 'number')
    assert.equal(station.last_reported, '2026-02-19T11:17:45.933Z')
    assert.ok(station.updated_at)

    const orphan = rows.find(row => row.station_id === '999')
    assert.ok(orphan)
    assert.equal(orphan.num_vehicles_available, undefined)
    assert.equal(orphan.is_renting, undefined)
  })

  it('nomme les types de véhicules disponibles à la station', async () => {
    const rows = await buildStations(documents, reference, 'fr', noopLog)
    const station = rows.find(row => row.station_id === '548')
    assert.ok(station)
    // both types are known, so they are named rather than left as bare ids
    assert.ok(!/^\d/.test(station.vehicle_types_available))
    assert.ok(station.vehicle_types_available.includes(' (1)'))
    assert.ok(station.vehicle_types_available.includes(' ; '))
  })

  it('dénormalise le type et le tarif de chaque véhicule', async () => {
    const rows = await buildVehicles(documents, reference, 'fr', noopLog)
    assert.equal(rows.length, 2)
    const vehicle = rows[0]
    assert.equal(vehicle.vehicle_id, '1515')
    assert.equal(vehicle._id, '1515')
    assert.equal(vehicle.vehicle_type_id, '11')
    assert.equal(vehicle.form_factor, 'car')
    assert.equal(vehicle.is_reserved, true)
    assert.equal(vehicle.is_disabled, true)
    assert.equal(vehicle.station_id, '1485')
    assert.equal(vehicle.current_fuel_percent, 0.6)
    // the vehicle carries no plan of its own: the one of its type applies
    assert.equal(vehicle.pricing_plan_id, reference.vehicleTypes.get('11')?.defaultPricingPlanId)
    assert.equal(vehicle.vehicle_equipment, undefined)
  })

  it('construit le catalogue des types de véhicules', async () => {
    const rows = await buildVehicleTypes(documents, reference, 'fr', noopLog)
    assert.ok(rows.length >= 2)
    const type = rows.find(row => row.vehicle_type_id === '1')
    assert.ok(type)
    assert.equal(type.name, 'Renault Twingo')
    assert.equal(type.make, 'Renault')
    assert.equal(type.model, 'Twingo')
    assert.equal(type.form_factor, 'car')
    assert.equal(type.propulsion_type, 'combustion')
  })

  it('rend les barèmes tarifaires lisibles', async () => {
    const rows = await buildPricingPlans(documents, 'fr', noopLog)
    assert.equal(rows.length, 1)
    const plan = rows[0]
    assert.equal(plan.currency, 'EUR')
    assert.equal(typeof plan.per_km_pricing, 'string')
    assert.ok(plan.per_km_pricing.includes('de 0 à 101 km : 0.42 EUR par 1 km'))
    assert.ok(plan.per_min_pricing.includes('(forfait)'))
  })

  it('produit une ligne par zone et par règle', async () => {
    const rows = await buildGeofencingZones(documents, 'fr', noopLog)
    // the zone carries two rules, and the zone without a geometry is dropped
    assert.equal(rows.length, 2)
    assert.equal(rows[0].name, 'Hypercentre')
    assert.equal(JSON.parse(rows[0].geometry).type, 'MultiPolygon')
    assert.equal(rows[0].vehicle_type_ids, '1')
    assert.equal(rows[0].ride_start_allowed, false)
    assert.equal(rows[0].maximum_speed_kph, 20)
    assert.equal(rows[1].ride_start_allowed, true)
    assert.notEqual(rows[0]._id, rows[1]._id)
  })

  it('résume le service pour le jeu de métadonnées', () => {
    const description = buildSystemDescription(documents, '3.0', 'fr')
    assert.ok(description)
    assert.ok(description.includes('Citiz Grand Poitiers'))
    assert.ok(description.includes('Régie des Transports Poitevins (RTP)'))
    assert.ok(description.includes('Europe/Paris'))
    assert.ok(description.includes('GBFS 3.0'))
    assert.equal(systemTitle(documents, 'fr'), 'Citiz Grand Poitiers')
  })
})

describe('construction des lignes en GBFS 2.x', () => {
  const documents = loadDocuments('v2', ['system_information', 'station_information', 'station_status', 'vehicle_status', 'vehicle_types'])
  const reference = buildReference(documents, 'fr')

  it('lit les stations malgré les anciens noms de champs', async () => {
    const rows = await buildStations(documents, reference, 'fr', noopLog)
    assert.equal(rows.length, 2)
    const station = rows[0]
    assert.equal(station.station_id, 'A1')
    assert.equal(station.name, 'Place du Marché')
    assert.equal(station.num_vehicles_available, 4)
    assert.equal(station.num_vehicles_disabled, 1)
    assert.equal(station.is_installed, true)
    assert.equal(station.is_returning, false)
    assert.equal(station.rental_methods, 'key;creditcard')
    assert.equal(station.last_reported, '2022-08-12T13:46:40.000Z')
  })

  it('lit les vélos publiés sous free_bike_status', async () => {
    const rows = await buildVehicles(documents, reference, 'fr', noopLog)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].vehicle_id, 'B-001')
    assert.equal(rows[0].is_reserved, false)
    assert.equal(rows[1].is_reserved, true)
    assert.equal(rows[0].vehicle_type_name, 'Vélo à assistance électrique')
    assert.equal(rows[0].propulsion_type, 'electric_assist')
    assert.equal(rows[0].current_range_meters, 45000)
  })

  it('résume un service 2.x sans libellés localisés', () => {
    const description = buildSystemDescription(documents, '2.2', 'fr')
    assert.ok(description)
    assert.ok(description.includes("Vélos d'Exemple"))
    assert.ok(description.includes("Régie d'Exemple"))
  })
})

describe('schémas produits', () => {
  it('déclare un schéma pour chaque ressource de données', () => {
    const schemas = buildSchemas()
    for (const key of Object.keys(RESOURCE_FEEDS) as (keyof typeof RESOURCE_FEEDS)[]) {
      assert.ok(schemas[key]?.length, `schéma manquant pour ${key}`)
      for (const property of schemas[key]) {
        assert.ok(property.key, 'une propriété sans clé')
        assert.ok(property.title, `titre manquant pour ${key}.${property.key}`)
        assert.ok(property.type, `type manquant pour ${key}.${property.key}`)
      }
      const keys = schemas[key].map(property => property.key)
      assert.equal(new Set(keys).size, keys.length, `clés dupliquées dans le schéma ${key}`)
    }
  })

  it('pose les concepts standard et les deux concepts propres au plugin', () => {
    const schemas = buildSchemas()
    assert.equal(schemas.stations.find(property => property.key === 'name')?.['x-refersTo'], 'http://www.w3.org/2000/01/rdf-schema#label')
    assert.equal(schemas.stations.find(property => property.key === 'lat')?.['x-refersTo'], 'http://schema.org/latitude')

    // the same concept on both sides of a join, otherwise annotating is pointless
    assert.equal(schemas.stations.find(property => property.key === 'station_id')?.['x-refersTo'], STATION_CONCEPT)
    assert.equal(schemas.vehicles.find(property => property.key === 'station_id')?.['x-refersTo'], STATION_CONCEPT)
    assert.equal(schemas.vehicles.find(property => property.key === 'vehicle_type_id')?.['x-refersTo'], VEHICLE_TYPE_CONCEPT)
    assert.equal(schemas['vehicle-types'].find(property => property.key === 'vehicle_type_id')?.['x-refersTo'], VEHICLE_TYPE_CONCEPT)
  })

  it('annonce les mêmes URI que celles écrites dans le formulaire', () => {
    // data-fair matches a concept by the URI listed in its identifiers: the note tells
    // the user what to declare, so it must state exactly what the plugin poses
    const note = JSON.stringify(processingSchema)
    assert.ok(note.includes(STATION_CONCEPT), 'URI du concept station absente du formulaire')
    assert.ok(note.includes(VEHICLE_TYPE_CONCEPT), 'URI du concept type de véhicule absente du formulaire')
  })

  it('ne produit que des lignes plates', async () => {
    const documents = loadDocuments('v3', ['station_information', 'station_status', 'vehicle_status', 'vehicle_types', 'system_pricing_plans', 'geofencing_zones'])
    const reference = buildReference(documents, 'fr')
    const rows = [
      ...await buildStations(documents, reference, 'fr', noopLog),
      ...await buildVehicles(documents, reference, 'fr', noopLog),
      ...await buildVehicleTypes(documents, reference, 'fr', noopLog),
      ...await buildPricingPlans(documents, 'fr', noopLog),
      ...await buildGeofencingZones(documents, 'fr', noopLog)
    ]
    assert.ok(rows.length)
    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        assert.ok(
          value === undefined || ['string', 'number', 'boolean'].includes(typeof value),
          `la colonne ${key} n'est pas plate : ${JSON.stringify(value)}`
        )
      }
    }
  })
})

describe('titres des jeux de données', () => {
  it('replie le titre de base sur le nom du service, puis sur GBFS', () => {
    const documents = loadDocuments('v3', ['system_information'])
    assert.equal(baseTitle('Mon service', documents, 'fr'), 'Mon service')
    // no schema default, so an empty field really reaches the fallback
    assert.equal(baseTitle(undefined, documents, 'fr'), 'Citiz Grand Poitiers')
    assert.equal(baseTitle('', documents, 'fr'), 'Citiz Grand Poitiers')
    assert.equal(baseTitle('   ', documents, 'fr'), 'Citiz Grand Poitiers')
    assert.equal(baseTitle(undefined, {}, 'fr'), 'GBFS')
  })

  it('laisse le jeu de métadonnées porter le titre de base', () => {
    assert.equal(datasetTitle('Citiz Grand Poitiers', 'system'), 'Citiz Grand Poitiers')
    assert.equal(datasetTitle('Citiz Grand Poitiers', 'stations'), 'Citiz Grand Poitiers - stations')
    assert.equal(datasetTitle('GBFS', 'geofencing-zones'), 'GBFS - zones de circulation')
  })
})

describe('utilitaires', () => {
  it('étiquette un type sans nom par sa marque et son modèle', () => {
    assert.equal(vehicleTypeLabel({ id: '1', name: 'Twingo' }), 'Twingo')
    assert.equal(vehicleTypeLabel({ id: '1', make: 'Renault', model: 'Clio' }), 'Renault Clio')
    assert.equal(vehicleTypeLabel({ id: '1' }), undefined)
    assert.equal(vehicleTypeLabel(undefined), undefined)
  })

  it('rend un barème vide comme absent', () => {
    assert.equal(formatPricingSegments([], 'km', 'EUR'), undefined)
    assert.equal(formatPricingSegments(undefined, 'km'), undefined)
    assert.equal(formatPricingSegments([{ start: 10, rate: 2 }], 'km', 'EUR'), 'au-delà de 10 km : 2 EUR (forfait)')
  })
})
