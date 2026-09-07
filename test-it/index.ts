import { describe, it } from 'node:test'
import assert from 'node:assert'
import testUtils from '@data-fair/lib-processing-dev/tests-utils.js'
import processingSchema from '../processing-config-schema.json' with { type: 'json' }
import * as gbfsProcessing from '../index.ts'

// #config refuses to load without a data-fair instance declared in config/local-test.mjs,
// which is gitignored: the integration test is then skipped
let config: any = null
try {
  config = (await import('#config')).default
} catch {
  config = null
}

const CITIZ_URL = 'https://backend.citiz.fr/public/provider/9/gbfs/v3.0/gbfs.json'

/** The two branches of the datasets tab, behind the mode guard that hides it in validate mode. */
const datasetModes = () => (processingSchema.allOf as any[])[2].allOf[0].then.oneOf
const createBranch = () => datasetModes()[0]
const updateBranch = () => datasetModes()[1]

describe('traitement GBFS', () => {
  it('expose les hooks attendus par la plateforme', () => {
    assert.equal(typeof gbfsProcessing.run, 'function')
    assert.equal(typeof gbfsProcessing.prepare, 'function')
    assert.equal(typeof gbfsProcessing.stop, 'function')
  })

  it('expose un schéma de configuration', () => {
    assert.equal(processingSchema.type, 'object')
    const tabs = processingSchema.allOf.map((tab: any) => tab.title)
    assert.deepEqual(tabs, ['Source', 'Traitement', 'Jeux de données'])
    // no vjsf 2 keyword left: they are silently ignored by the renderer
    assert.ok(!JSON.stringify(processingSchema).includes('"x-'))
  })

  it('déclare les mêmes rôles à la création et à la mise à jour', () => {
    const created = createBranch().properties.resources.items.oneOf.map((role: any) => role.const)
    const updated = Object.keys(updateBranch().properties.datasets.properties)
    assert.deepEqual([...created].sort(), [...updated].sort())
    // every role is produced unless the user unchecks it
    assert.deepEqual([...createBranch().properties.resources.default].sort(), [...created].sort())
  })

  it('donne un sélecteur cherchable et non tronqué à chaque rôle', () => {
    for (const role of Object.values<any>(updateBranch().properties.datasets.properties)) {
      const { url, qSearchParam } = role.layout.getItems
      // without one of the two the picker loads every dataset at once
      assert.ok(url.includes('{q}') || qSearchParam)
      // data-fair returns 12 results by default, too few for a usable autocomplete
      assert.ok(url.includes('size=50'))
      assert.deepEqual(role.required, ['id'])
    }
  })

  it('lit la liste des ressources dans ses deux formes', async () => {
    const { wantedFromResources } = await import('../lib/execute.ts')
    assert.deepEqual(wantedFromResources(['stations', 'vehicles']), ['stations', 'vehicles'])
    // configurations written before the list became a multi-select carry an object
    assert.deepEqual(wantedFromResources({ stations: true, vehicles: false }), ['stations'])
    assert.deepEqual(wantedFromResources([]), [])
    assert.deepEqual(wantedFromResources(undefined), [])
    // the order comes from the plugin, not from what the user clicked first
    assert.deepEqual(wantedFromResources(['vehicles', 'system']), ['system', 'vehicles'])
  })

  it('résume un rapport de validation', async () => {
    const { summarize } = await import('../lib/validate.ts')
    const summary = summarize({
      summary: { validatorVersion: '1.0.18', version: { detected: '3.0', validated: '3.0' }, hasErrors: true, errorsCount: 4 },
      files: [
        { file: 'gbfs.json', required: true, exists: true, hasErrors: true, errorsCount: 1, errors: [{ message: "must have required property 'last_updated'" }] },
        { file: 'system_information.json', required: true, exists: false, hasErrors: true, errorsCount: 1 },
        { file: 'vehicle_types.json', required: false, exists: true, hasErrors: true, errorsCount: 2, errors: [{ message: 'a' }, { message: 'b' }] },
        { file: 'geofencing_zones.json', required: false, exists: false, hasErrors: false, errorsCount: 0 }
      ]
    })
    assert.equal(summary.errorsCount, 4)
    assert.equal(summary.detectedVersion, '3.0')
    // a missing or invalid mandatory file blocks, an optional one in error does not
    assert.deepEqual(summary.blockingFiles, ['gbfs.json', 'system_information.json'])
  })

  it('ne bloque pas sur une version que le validateur ne connaît pas', async () => {
    const { summarize } = await import('../lib/validate.ts')
    const summary = summarize({ summary: { validatorVersion: '1.0.18', versionUnimplemented: true } })
    assert.equal(summary.versionUnimplemented, true)
    assert.equal(summary.errorsCount, 0)
    assert.deepEqual(summary.blockingFiles, [])
  })

  it('laisse la configuration intacte, faute de secret à extraire', async () => {
    const processingConfig: any = { datasetMode: 'create', url: CITIZ_URL }
    const result = await gbfsProcessing.prepare({ processingConfig, secrets: {} })
    assert.deepEqual(result.processingConfig, processingConfig)
    assert.deepEqual(result.secrets, {})
  })

  it('crée les jeux de données demandés', { skip: !config?.dataFairUrl, timeout: 300000 }, async () => {
    const context = testUtils.context({
      processingConfig: {
        datasetMode: 'create',
        datasetTitle: 'GBFS Test',
        resources: ['system', 'stations', 'vehicles', 'vehicle-types', 'pricing-plans', 'geofencing-zones'],
        url: CITIZ_URL,
        language: 'fr'
      },
      tmpDir: 'data/tmp-gbfs-test'
    }, config, false)

    await gbfsProcessing.run(context as any)
    assert.equal(context.processingConfig.datasetMode, 'update')
    // the create run rewrites the configuration as one dataset per role
    assert.ok(Object.keys(context.processingConfig.datasets).length)
    assert.ok(context.processingConfig.datasets.stations.id)
  })
})
