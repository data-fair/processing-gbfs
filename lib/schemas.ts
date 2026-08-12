export interface SchemaProperty {
  key: string
  title: string
  description?: string
  type: string
  format?: string
  separator?: string
  ignoreDetection?: boolean
  'x-refersTo'?: string
  'x-labels'?: Record<string, string>
  'x-capabilities'?: Record<string, boolean>
}

export type ResourceKey = 'system' | 'stations' | 'vehicles' | 'vehicle-types' | 'pricing-plans' | 'geofencing-zones'

export type DataResourceKey = Exclude<ResourceKey, 'system'>

export const RESOURCE_TITLES: Record<ResourceKey, string> = {
  system: 'métadonnées',
  stations: 'stations',
  vehicles: 'véhicules',
  'vehicle-types': 'types de véhicules',
  'pricing-plans': 'tarifs',
  'geofencing-zones': 'zones de circulation'
}

/**
 * The GBFS feeds each resource is built from.
 *
 * `required` missing from the service means the resource cannot be produced at all;
 * `optional` missing only degrades it (a station without its availability, a vehicle
 * without its model), which the builders report as a warning.
 */
export const RESOURCE_FEEDS: Record<DataResourceKey, { required: string, optional: string[] }> = {
  stations: { required: 'station_information', optional: ['station_status', 'vehicle_types'] },
  vehicles: { required: 'vehicle_status', optional: ['vehicle_types', 'system_pricing_plans'] },
  'vehicle-types': { required: 'vehicle_types', optional: ['system_pricing_plans'] },
  'pricing-plans': { required: 'system_pricing_plans', optional: [] },
  'geofencing-zones': { required: 'geofencing_zones', optional: [] }
}

const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label'
const DESCRIPTION = 'http://schema.org/description'
const GEOMETRY = 'https://purl.org/geojson/vocab#geometry'
const LATITUDE = 'http://schema.org/latitude'
const LONGITUDE = 'http://schema.org/longitude'
const ADDRESS = 'http://schema.org/address'
const POSTAL_CODE = 'http://schema.org/postalCode'
const WEB_PAGE = 'https://schema.org/WebPage'
const PHONE = 'https://www.w3.org/2006/vcard/ns#tel'

// GBFS identifiers are strings. Declaring them integer breaks every service using
// alphanumeric ids, and ignoreDetection does not help: it suppresses detection, not
// the declared type.
const id = (key: string, title: string, description?: string): SchemaProperty =>
  ({ key, title, description, type: 'string', ignoreDetection: true })

const instant = (key: string, title: string, description?: string): SchemaProperty =>
  ({ key, title, description, type: 'string', format: 'date-time' })

const updatedAt = instant(
  'updated_at',
  'Date de production du flux',
  "Instant auquel le service a produit le flux lu par cette exécution. C'est la date de validité de l'état publié ici."
)

// the "undefined" key labels rows where the column is empty: data-fair looks labels up
// with `'' + value`, which turns a missing value into the string "undefined"
const formFactor: SchemaProperty = {
  key: 'form_factor',
  title: 'Catégorie de véhicule',
  type: 'string',
  // no x-labelsRestricted: the list grows with each version of the specification, and a
  // value that is not labelled here must still be published
  'x-labels': {
    undefined: 'Non renseignée',
    bicycle: 'Vélo',
    cargo_bicycle: 'Vélo cargo',
    car: 'Voiture',
    moped: 'Cyclomoteur',
    scooter: 'Trottinette',
    scooter_seated: 'Trottinette avec selle',
    scooter_standing: 'Trottinette sans selle',
    other: 'Autre'
  }
}

const propulsionType: SchemaProperty = {
  key: 'propulsion_type',
  title: 'Motorisation',
  type: 'string',
  'x-labels': {
    undefined: 'Non renseignée',
    human: 'Musculaire',
    electric_assist: 'Assistance électrique',
    electric: 'Électrique',
    combustion: 'Thermique',
    combustion_diesel: 'Thermique diesel',
    hybrid: 'Hybride',
    plug_in_hybrid: 'Hybride rechargeable',
    hydrogen_fuel_cell: 'Pile à hydrogène'
  }
}

const parkingType: SchemaProperty = {
  key: 'parking_type',
  title: 'Type de stationnement',
  type: 'string',
  'x-labels': {
    undefined: 'Non renseigné',
    parking_lot: 'Parking dédié',
    street_parking: 'Stationnement sur voirie',
    underground_parking: 'Parking souterrain',
    sidewalk_parking: 'Stationnement sur trottoir',
    other: 'Autre'
  }
}

const returnConstraint: SchemaProperty = {
  key: 'return_constraint',
  title: 'Contrainte de restitution',
  type: 'string',
  'x-labels': {
    undefined: 'Non renseignée',
    free_floating: 'Libre-service intégral',
    roundtrip_station: 'Retour à la station de départ',
    any_station: "N'importe quelle station",
    hybrid: 'Station ou libre-service'
  }
}

const geometryProperty: SchemaProperty = {
  key: 'geometry',
  title: 'Géométrie',
  type: 'string',
  'x-refersTo': GEOMETRY,
  'x-capabilities': { textAgg: false }
}

/**
 * station_id and vehicle_type_id are what join the produced datasets to each other and
 * to an organisation's own reference data, but the standard vocabulary has no concept
 * for either. Annotating them takes a private vocabulary, so it is left to whoever owns
 * one: refreshSchema never touches x-refersTo, so a concept set by hand survives.
 */
export const buildSchemas = (): Record<DataResourceKey, SchemaProperty[]> => ({
  stations: [
    id('station_id', 'Identifiant de la station'),
    { key: 'name', title: 'Nom de la station', type: 'string', 'x-refersTo': LABEL },
    { key: 'short_name', title: 'Nom court', type: 'string' },
    { key: 'address', title: 'Adresse', type: 'string', 'x-refersTo': ADDRESS },
    { key: 'post_code', title: 'Code postal', type: 'string', 'x-refersTo': POSTAL_CODE, ignoreDetection: true },
    { key: 'cross_street', title: 'Rue transversale', type: 'string' },
    { key: 'lat', title: 'Latitude', type: 'number', 'x-refersTo': LATITUDE },
    { key: 'lon', title: 'Longitude', type: 'number', 'x-refersTo': LONGITUDE },
    { key: 'capacity', title: 'Capacité', description: 'Nombre total de véhicules que la station peut accueillir.', type: 'integer' },
    parkingType,
    { key: 'is_virtual_station', title: 'Station virtuelle', description: 'Zone de stationnement sans infrastructure physique.', type: 'boolean' },
    { key: 'contact_phone', title: 'Téléphone', type: 'string', 'x-refersTo': PHONE },
    { key: 'rental_methods', title: 'Moyens de paiement', type: 'string', separator: ';' },
    { key: 'num_vehicles_available', title: 'Véhicules disponibles', type: 'integer' },
    { key: 'num_vehicles_disabled', title: 'Véhicules indisponibles', type: 'integer' },
    { key: 'num_docks_available', title: 'Bornes libres', type: 'integer' },
    { key: 'num_docks_disabled', title: 'Bornes hors service', type: 'integer' },
    { key: 'vehicle_types_available', title: 'Véhicules disponibles par type', description: 'Modèles présents à la station, suivis de leur nombre.', type: 'string' },
    { key: 'is_installed', title: 'Station déployée', type: 'boolean' },
    { key: 'is_renting', title: 'Location possible', type: 'boolean' },
    { key: 'is_returning', title: 'Restitution possible', type: 'boolean' },
    instant('last_reported', 'Dernier relevé', 'Instant auquel la station a rapporté sa disponibilité.'),
    updatedAt
    // station_area is deliberately left out: the geometry concept next to the latitude
    // and longitude ones would give data-fair two competing sources for the same map
  ],
  vehicles: [
    id('vehicle_id', 'Identifiant du véhicule', 'Réattribué à chaque location par les services qui protègent la vie privée de leurs usagers.'),
    { key: 'lat', title: 'Latitude', type: 'number', 'x-refersTo': LATITUDE },
    { key: 'lon', title: 'Longitude', type: 'number', 'x-refersTo': LONGITUDE },
    id('station_id', 'Station', 'Station où le véhicule est stationné.'),
    id('home_station_id', "Station d'attache", 'Station à laquelle le véhicule doit être rendu.'),
    id('vehicle_type_id', 'Identifiant du type de véhicule'),
    { key: 'vehicle_type_name', title: 'Modèle', type: 'string', 'x-refersTo': LABEL },
    formFactor,
    propulsionType,
    { key: 'make', title: 'Marque', type: 'string' },
    { key: 'model', title: 'Modèle du constructeur', type: 'string' },
    { key: 'current_range_meters', title: 'Autonomie restante (m)', type: 'number' },
    { key: 'current_fuel_percent', title: 'Niveau de charge ou de carburant', description: 'Proportion comprise entre 0 et 1, telle que publiée par le service.', type: 'number' },
    { key: 'is_reserved', title: 'Réservé', type: 'boolean' },
    { key: 'is_disabled', title: 'Indisponible', type: 'boolean' },
    id('pricing_plan_id', 'Identifiant du tarif'),
    { key: 'pricing_plan_name', title: 'Tarif', type: 'string' },
    { key: 'vehicle_equipment', title: 'Équipements', type: 'string', separator: ';' },
    instant('available_until', 'Disponible jusqu\'au'),
    instant('last_reported', 'Dernier relevé'),
    updatedAt
  ],
  'vehicle-types': [
    id('vehicle_type_id', 'Identifiant du type de véhicule'),
    { key: 'name', title: 'Nom', type: 'string', 'x-refersTo': LABEL },
    formFactor,
    propulsionType,
    { key: 'make', title: 'Marque', type: 'string' },
    { key: 'model', title: 'Modèle', type: 'string' },
    { key: 'max_range_meters', title: 'Autonomie maximale (m)', description: 'Publié à 0 par les services qui ne mesurent pas cette autonomie.', type: 'number' },
    { key: 'wheel_count', title: 'Nombre de roues', type: 'integer' },
    { key: 'rider_capacity', title: 'Nombre de places', type: 'integer' },
    { key: 'cargo_volume_capacity', title: 'Volume de chargement (l)', type: 'number' },
    { key: 'cargo_load_capacity', title: 'Charge utile (kg)', type: 'number' },
    returnConstraint,
    id('default_pricing_plan_id', 'Identifiant du tarif par défaut'),
    { key: 'default_pricing_plan_name', title: 'Tarif par défaut', type: 'string' },
    updatedAt
  ],
  'pricing-plans': [
    id('plan_id', 'Identifiant du tarif'),
    { key: 'name', title: 'Nom', type: 'string', 'x-refersTo': LABEL },
    { key: 'description', title: 'Description', type: 'string', 'x-refersTo': DESCRIPTION },
    { key: 'url', title: 'Page du tarif', type: 'string', 'x-refersTo': WEB_PAGE },
    { key: 'currency', title: 'Devise', type: 'string' },
    { key: 'price', title: 'Prix de base', description: "Prix d'accès, hors barèmes kilométrique et horaire.", type: 'number' },
    { key: 'is_taxable', title: 'Taxable', type: 'boolean' },
    { key: 'surge_pricing', title: 'Tarification dynamique', type: 'boolean' },
    { key: 'per_km_pricing', title: 'Barème kilométrique', type: 'string' },
    { key: 'per_min_pricing', title: 'Barème horaire', type: 'string' },
    { key: 'reservation_price_per_min', title: 'Prix de réservation par minute', type: 'number' },
    { key: 'reservation_price_flat_rate', title: 'Forfait de réservation', type: 'number' },
    { key: 'vehicle_type_ids', title: 'Types de véhicules concernés', type: 'string', separator: ';' },
    updatedAt
  ],
  'geofencing-zones': [
    geometryProperty,
    { key: 'name', title: 'Nom de la zone', type: 'string', 'x-refersTo': LABEL },
    instant('start', 'Début de validité'),
    instant('end', 'Fin de validité'),
    { key: 'vehicle_type_ids', title: 'Types de véhicules concernés', description: 'Vide lorsque la règle vaut pour tous les véhicules.', type: 'string', separator: ';' },
    { key: 'ride_start_allowed', title: 'Départ autorisé', type: 'boolean' },
    { key: 'ride_end_allowed', title: 'Arrivée autorisée', type: 'boolean' },
    { key: 'ride_through_allowed', title: 'Traversée autorisée', type: 'boolean' },
    { key: 'maximum_speed_kph', title: 'Vitesse maximale (km/h)', type: 'integer' },
    { key: 'station_parking', title: 'Stationnement en station obligatoire', type: 'boolean' },
    updatedAt
  ]
})

/**
 * Properties data-fair considers innocuous, so they can be refreshed on an existing
 * dataset without breaking its schema. Everything else (types, concepts, x-transform
 * patches applied by hand) is left untouched.
 */
export const REFRESHABLE_PROPS = ['title', 'description', 'x-labels'] as const
