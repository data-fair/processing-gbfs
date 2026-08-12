import { localized, text, type GbfsDocument } from './normalize.ts'

export interface VehicleTypeRef {
  id: string
  name?: string
  formFactor?: string
  propulsionType?: string
  make?: string
  model?: string
  defaultPricingPlanId?: string
}

/**
 * The lookup tables the row builders denormalize from: a station or a vehicle carries
 * an id, and a dataset carrying only ids is unusable without a join the user cannot do.
 */
export interface Reference {
  vehicleTypes: Map<string, VehicleTypeRef>
  /** pricing plan id to its name */
  pricingPlans: Map<string, string>
}

export const buildReference = (documents: Record<string, GbfsDocument>, language?: string): Reference => {
  const vehicleTypes = new Map<string, VehicleTypeRef>()
  for (const row of documents.vehicle_types?.data?.vehicle_types ?? []) {
    const id = text(row?.vehicle_type_id)
    if (!id) continue
    vehicleTypes.set(id, {
      id,
      name: localized(row.name, language),
      formFactor: text(row.form_factor),
      propulsionType: text(row.propulsion_type),
      make: localized(row.make, language),
      model: localized(row.model, language),
      defaultPricingPlanId: text(row.default_pricing_plan_id)
    })
  }

  const pricingPlans = new Map<string, string>()
  for (const row of documents.system_pricing_plans?.data?.plans ?? []) {
    const id = text(row?.plan_id)
    const name = localized(row?.name, language)
    if (id && name) pricingPlans.set(id, name)
  }

  return { vehicleTypes, pricingPlans }
}

/** A vehicle type without a name is still worth labelling by its make and model. */
export const vehicleTypeLabel = (type?: VehicleTypeRef): string | undefined => {
  if (!type) return undefined
  if (type.name) return type.name
  return [type.make, type.model].filter(Boolean).join(' ') || undefined
}
