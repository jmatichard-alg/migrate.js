#!/usr/bin/env node
const DOC = `
Usage:
  migrate.js up <host> <port> <db> [--dry-run]
  migrate.js down <host> <port> <db> <version> [--dry-run]
  migrate.js -h | --help | --version
`;

const _ = require('lodash');
const docopt = require('docopt').docopt;
const MongoClient = require('mongodb').MongoClient;
const requireDir = require('require-dir');

const pkg = require('./package.json');

function loadMigrations() {
  const allMigrations = requireDir(`${process.cwd()}/migrations`);
  const migrationIdRe = /^([\d]+)/;

  let idSet = new Set();

  function extractMigId(name) {
    let id = name.match(migrationIdRe)[1];
    if (!id) throw Error(`missing id in ${name}`);
    return parseInt(id, 10);
  }

  const migrations = _(allMigrations)
    .map((migration, name) => {
      const id = extractMigId(name);
      if (idSet.has(id))
        throw Error(`duplicate id ${id} while processing ${name}`);
      idSet.add(id);

      if (!_.isFunction(migration.up))
        throw Error(`missing 'up' function in ${name}`);
      if (!_.isFunction(migration.down))
        throw Error(`missing 'down' function in ${name}`);

      // TODO: validate migration (ensure up and down funcs are defined)
      return {
        name,
        id,
        up: migration.up,
        down: migration.down
      };
    })
    .sortBy('id')
    .value();

  return migrations;
}

const DEFAULT_OPTS = {
  func: 'up',
  version: null,
  host: null,
  port: 27017,
  database: null,
  dryRun: false
};

async function main(opts) {
  const _opts = _.assign({}, DEFAULT_OPTS, opts);

  const db = await MongoClient.connect(
    `mongodb://${_opts.host}:${_opts.port}/${_opts.database}`
  );
  const migrationCollection = db.collection('__migrations');

  const allMigrations = loadMigrations();

  // load existing migration info
  let migrationInfo = await migrationCollection.findOne({ _id: 'default' });
  migrationInfo = _.defaults(migrationInfo, {
    migId: 0
  });

  console.log(`current database version is '${migrationInfo.migId}'`);

  // determine pending migrations
  let pendingMigrations = [];
  if (_opts.func === 'up') {
    pendingMigrations = _.filter(
      allMigrations,
      m => m.id > migrationInfo.migId
    );
  } else if (_opts.func === 'down') {
    const requestedMigId = _.get(_opts, 'version', migrationInfo.migId);
    pendingMigrations = _.filter(
      allMigrations,
      m => m.id > requestedMigId && m.id <= migrationInfo.migId
    );
    _.reverse(pendingMigrations);
  } else {
    throw new Error(`Invalid func ${_opts.func} - ["up", "down"]`);
  }

  // if dry run, just display which migrations would be run
  if (_opts.dryRun) {
    console.log('dry run mode : the following migrations would be applied:');
    _(pendingMigrations).each(m => console.log(` - ${m.name}`));
    return await db.close();
  }

  // TODO: make migration on a mirror of data for easy rollback ?

  const migrationCtx = {
    db,
    updateCollection: async function(collection, updater) {
      const col = db.collection(collection);
      const chunkSize = 1000;
      let idx = 0;
      while (true) {
        const docs = await col
          .find({})
          .skip(idx++ * chunkSize)
          .limit(chunkSize)
          .toArray();
        if (_.isEmpty(docs)) break;
        const newDocs = await Promise.all(_.map(docs, doc => updater(doc)));
        for (const doc of newDocs) await col.updateOne({ _id: doc._id }, doc);
      }
    }
  };

  if (!pendingMigrations.length) {
    console.log('already up to date : no migration to apply!');
    return await db.close();
  }

  console.log('applying the following migrations:');
  for (const m of pendingMigrations) {
    if (_opts.func === 'up') {
      console.log(` - applying ${m.name}...`);
      await m.up.bind(migrationCtx)();
      await migrationCollection.updateOne(
        { _id: 'default' },
        { migId: m.id },
        { upsert: true }
      );
    } else {
      console.log(` - reverting ${m.name}...`);
      await m.down.bind(migrationCtx)();
      await migrationCollection.updateOne(
        { _id: 'default' },
        { migId: m.id - 1 },
        { upsert: true }
      );
    }
    console.log(`   done ${m.name}!`);
  }

  await db.close();
}
module.exports = main;

// If module is launched on it's own
if (require.main === module) {
  const args = docopt(DOC, { version: pkg.version });
  const version = parseInt(args['<version>'], 10);
  const host = args['<host>'];
  const port = args['<port>'];
  const database = args['<db>'];
  const dryRun = args['--dry-run'] != null;

  main({
    up: _.get(args, 'up', false),
    version,
    host,
    port,
    database,
    dryRun
  }).catch(console.error);
}
