#!/usr/bin/env node
'use strict'

const DOC = `
Usage:
  migrate up <host> <port> <db> [--dry-run]
  migrate down <host> <port> <db> <version> [--dry-run]
  migrate -h | --help | --version
`

const _ = require('lodash')
const co = require('co')
const docopt = require('docopt').docopt
const MongoClient = require('mongodb').MongoClient
const requireDir = require('require-dir')

const pkg = require('./package.json')

function loadMigrations () {
  const allMigrations = requireDir(`${process.cwd()}/migrations`)
  const migrationIdRe = /^([\d]+)/

  let idSet = new Set()

  function extractMigId (name) {
    let id = name.match(migrationIdRe)[1]
    if (!id) throw Error(`missing id in ${name}`)
    return parseInt(id, 10)
  }

  const migrations = _(allMigrations)
    .map((migration, name) => {
      const id = extractMigId(name)
      if (idSet.has(id)) throw Error(`duplicate id ${id} while processing ${name}`)
      idSet.add(id)

      if (!_.isFunction(migration.up)) throw Error(`missing 'up' function in ${name}`)
      if (!_.isFunction(migration.down)) throw Error(`missing 'down' function in ${name}`)

      // TODO: validate migration (ensure up and down funcs are defined)
      return {
        name,
        id,
        up: migration.up,
        down: migration.down
      }
    })
    .sortBy('id')
    .value()

  return migrations
}

function * main () {
  const args = docopt(DOC, { version: pkg.version })
  const host = args['<host>']
  const port = args['<port>']
  const database = args['<db>']
  const db = yield MongoClient.connect(`mongodb://${host}:${port}/${database}`)
  const migrationCollection = db.collection('__migrations')

  const allMigrations = loadMigrations()

  // load existing migration info
  let migrationInfo = yield migrationCollection.findOne({_id: 'default'})
  migrationInfo = _.defaults(migrationInfo, {
    migId: 0
  })

  console.log(`current database version is '${migrationInfo.migId}'`)

  // determine pending migrations
  let pendingMigrations = []
  let func = ''
  if (args.up) {
    func = 'up'
    pendingMigrations = _.filter(allMigrations, m => m.id > migrationInfo.migId)
  } else {
    func = 'down'
    const requestedMigId = parseInt(args['<version>'], 10)
    pendingMigrations = _.filter(allMigrations, m => m.id > requestedMigId && m.id <= migrationInfo.migId)
    _.reverse(pendingMigrations)
  }

  // if dry run, just display which migrations would be run
  if (args['--dry-run']) {
    console.log('dry run mode : the following migrations would be applied:')
    _(pendingMigrations).each(m => console.log(` - ${m.name}`))
    return yield db.close()
  }

  // TODO: make migration on a mirror of data for easy rollback ?

  const migrationCtx = {
    db,
    updateCollection: function * (collection, updater) {
      const col = db.collection(collection)
      const chunkSize = 1000
      let idx = 0
      while (true) {
        const docs = yield col.find({}).skip(idx++ * chunkSize).limit(chunkSize).toArray()
        if (_.isEmpty(docs)) break
        const newDocs = yield docs.map(updater)
        for (var doc of newDocs) yield col.updateOne({ _id: doc._id }, doc)
      }
    }
  }

  if (!pendingMigrations.length) {
    console.log('already up to date : no migration to apply!')
    return yield db.close()
  }

  console.log('applying the following migrations:')
  for (const m of pendingMigrations) {
    if (func === 'up') {
      console.log(` - applying ${m.name}...`)
      yield m.up.bind(migrationCtx)
      yield migrationCollection.updateOne({ _id: 'default' }, { migId: m.id }, { upsert: true })
    } else {
      console.log(` - reverting ${m.name}...`)
      yield m.down.bind(migrationCtx)
      yield migrationCollection.updateOne({ _id: 'default' }, { migId: m.id - 1 }, { upsert: true })
    }
    console.log(`   done ${m.name}!`)
  }

  yield db.close()
}

// If module is launched on it's own
if (require.main === module) {
  co(main).catch(console.error)
}
