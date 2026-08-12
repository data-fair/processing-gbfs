import { describe, it } from 'node:test'
import assert from 'node:assert'
import testUtils from '@data-fair/lib-processing-dev/tests-utils.js'
import processingSchema from '../processing-config-schema.json' with { type: 'json' }
import * as gbfsProcessing from '../index.ts'

// the integration test needs a data-fair instance, declared in config/local-test.mjs
let config: any = null
try {
  config = (await import('../lib/config.ts')).default
} catch {
  config = null
}

const CITIZ_URL = 'https://backend.citiz.fr/public/provider/9/gbfs/v3.0/gbfs.json'

describe('traitement GBFS', () => {
  it('expose les hooks attendus par la plateforme', () => {
    assert.equal(typeof gbfsProcessing.run, 'function')
    assert.equal(typeof gbfsProcessing.prepare, 'function')
    assert.equal(typeof gbfsProcessing.stop, 'function')
  })

  it('expose un schéma de configuration', () => {
    assert.equal(processingSchema.type, 'object')
    const tabs = processingSchema.allOf.map((tab: any) => tab.title)
    assert.deepEqual(tabs, ['Jeux de données', 'Paramètres', 'Concepts'])
  })

  it('déclare les mêmes rôles à la création et à la mise à jour', () => {
    const [datasetsTab] = processingSchema.allOf as any[]
    const resources = datasetsTab.oneOf[0].properties.resources
    const created = resources.items.oneOf.map((role: any) => role.const)
    const updated = datasetsTab.oneOf[1].properties.datasets.items.properties.key.oneOf.map((role: any) => role.const)
    assert.deepEqual([...created].sort(), [...updated].sort())
    // every role is produced unless the user unchecks it
    assert.deepEqual([...resources.default].sort(), [...created].sort())
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
    assert.ok(context.processingConfig.datasets.length)
  })
})
