import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { attachToParent } from '../lib/fragments.ts'
import { syncRelatedDatasets } from '../lib/upload.ts'

const makeLog = () => {
  const warnings: string[] = []
  const log: any = {
    step: async () => {},
    info: async () => {},
    warning: async (msg: string) => { warnings.push(msg) },
    error: async () => {},
    debug: async () => {}
  }
  return { log, warnings }
}

/** Stub recording the PATCH bodies; `refuse` makes data-fair answer 400 like it does for a published dataset. */
const fakeAxios = (refuse?: string) => {
  const patches: { url: string, body: any }[] = []
  const axios: any = {
    patch: async (url: string, body: any) => {
      if (refuse) {
        const err: any = new Error('Request failed with status code 400')
        err.response = { status: 400, data: refuse }
        throw err
      }
      patches.push({ url, body })
      return { data: {} }
    }
  }
  return { axios, patches }
}

describe('rattachement au jeu de métadonnées', () => {
  it('rattache un jeu autonome', async () => {
    const { axios, patches } = fakeAxios()
    const { log } = makeLog()
    assert.equal(await attachToParent(axios, { id: 'stops' }, 'meta', log), true)
    assert.deepEqual(patches, [{ url: 'api/v1/datasets/stops', body: { partOf: { type: 'dataset', id: 'meta' } } }])
  })

  it('ne refait rien sur un jeu déjà rattaché', async () => {
    const { axios, patches } = fakeAxios()
    const { log } = makeLog()
    assert.equal(await attachToParent(axios, { id: 'stops', partOf: { type: 'dataset', id: 'meta' } }, 'meta', log), true)
    assert.equal(patches.length, 0)
  })

  it('laisse en place un jeu rattaché à la main ailleurs', async () => {
    const { axios, patches } = fakeAxios()
    const { log, warnings } = makeLog()
    assert.equal(await attachToParent(axios, { id: 'stops', partOf: { type: 'application', id: 'app' } }, 'meta', log), false)
    assert.equal(patches.length, 0)
    assert.equal(warnings.length, 1)
  })

  it('avertit sans échouer quand data-fair refuse le rattachement', async () => {
    const { axios } = fakeAxios('a fragment cannot be published on a portal')
    const { log, warnings } = makeLog()
    assert.equal(await attachToParent(axios, { id: 'stops', title: 'Stations' }, 'meta', log), false)
    assert.match(warnings[0], /Stations.*published on a portal/)
  })
})

describe('liens entre jeux de la famille', () => {
  const refs: any[] = [
    { key: 'system', id: 'meta', title: 'GBFS' },
    { key: 'stations', id: 'stops', title: 'GBFS - Stations' },
    { key: 'vehicles', id: 'shapes', title: 'GBFS - Véhicules' }
  ]
  const fakeDatasets = (related: Record<string, any[]>) => {
    const patches: Record<string, any[]> = {}
    const axios: any = {
      get: async (url: string) => ({ data: { relatedDatasets: related[url.replace('api/v1/datasets/', '')] ?? [] } }),
      patch: async (url: string, body: any) => { patches[url.replace('api/v1/datasets/', '')] = body.relatedDatasets; return { data: {} } }
    }
    return { axios, patches }
  }

  it('retire les liens entre membres du groupe et garde ceux posés vers d\'autres jeux', async () => {
    const foreign = { id: 'ailleurs', title: 'Autre jeu' }
    const { axios, patches } = fakeDatasets({
      meta: [foreign, { id: 'stops', title: 'GBFS - Stations' }, { id: 'shapes', title: 'GBFS - Véhicules' }],
      stops: [{ id: 'meta', title: 'GBFS' }, { id: 'shapes', title: 'GBFS - Véhicules' }],
      shapes: [{ id: 'meta', title: 'GBFS' }, { id: 'stops', title: 'GBFS - Stations' }]
    })
    await syncRelatedDatasets(axios, refs, makeLog().log, new Set(['meta', 'stops', 'shapes']))
    assert.deepEqual(patches, { meta: [foreign], stops: [], shapes: [] })
  })

  it('garde les liens vers un membre dont le rattachement a été refusé', async () => {
    const { axios, patches } = fakeDatasets({})
    await syncRelatedDatasets(axios, refs, makeLog().log, new Set(['meta', 'stops']))
    assert.deepEqual(patches.meta, [{ id: 'shapes', title: 'GBFS - Véhicules' }])
    assert.deepEqual(patches.shapes, [{ id: 'meta', title: 'GBFS' }, { id: 'stops', title: 'GBFS - Stations' }])
  })

  it('relie tous les jeux entre eux quand la famille n\'est pas regroupée', async () => {
    const { axios, patches } = fakeDatasets({})
    await syncRelatedDatasets(axios, refs, makeLog().log)
    assert.equal(patches.stops.length, 2)
  })
})
