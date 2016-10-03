# Migrate.js

## Introduction

This is a minimalist MongoDB only (for the moment) migration framework. It comes with a basic CLI tool to help you manage your database migrations.


## Installation

### Locally

`npm i --save migrate.js`

The CLI tool is available in `./node_modules/migrate.js/migrate.js` or as `migrate.js` if accessed in your scripts section of your package.json file.


### Globally

`npm i -g migrate.js`

The CLI tool is available as migrate.js. Simply execute it from your base project directory, where the migrations folder resides.


## Migration files

Create a folder named `migrations` in your project and store your migration files here. The files should be named with the following pattern : `xxxx-this-is-an-updater.js`.

### Example migration file

```js
// 0001-add-new-field.js

exports.up = function * () {
  yield this.updateCollection('products', function * (doc) {
    doc.newField = 'this is the extra field'
    return doc
  })
}

exports.down = function * () {
  yield this.updateCollection('products', function * (doc) {
    delete doc.newField
    return doc
  })
}
```
