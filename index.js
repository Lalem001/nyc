/* global __coverage__ */
var fs = require('fs')
var glob = require('glob')
var micromatch = require('micromatch')
var mkdirp = require('mkdirp')
var appendTransform = require('append-transform')
var cachingTransform = require('caching-transform')
var path = require('path')
var rimraf = require('rimraf')
var onExit = require('signal-exit')
var stripBom = require('strip-bom')
var resolveFrom = require('resolve-from')
var arrify = require('arrify')
var SourceMapCache = require('./lib/source-map-cache')
var convertSourceMap = require('convert-source-map')
var md5hex = require('md5-hex')

/* istanbul ignore next */
if (/index\.covered\.js$/.test(__filename)) {
  require('./lib/self-coverage-helper')
}

function NYC (opts) {
  opts = opts || {}

  this._istanbul = opts.istanbul
  this.subprocessBin = opts.subprocessBin || path.resolve(__dirname, './bin/nyc.js')
  this._tempDirectory = opts.tempDirectory || './.nyc_output'
  this._cacheDirectory = opts.cacheDirectory || './node_modules/.cache/nyc'
  this.cwd = opts.cwd || process.env.NYC_CWD || process.cwd()
  this.reporter = arrify(opts.reporter || 'text')

  // you can specify config in the nyc stanza of package.json.
  var config = require(path.resolve(this.cwd, './package.json')).config || {}
  config = config.nyc || {}

  // load exclude stanza from config.
  this.include = false
  if (config.include) {
    this.include = this._prepGlobPatterns(arrify(config.include))
  }

  this.exclude = this._prepGlobPatterns(
    ['**/node_modules/**'].concat(arrify(config.exclude || ['test/**', 'test{,-*}.js']))
  )

  this.enableCache = opts.enableCache === true || process.env.NYC_CACHE === 'enable'

  // require extensions can be provided as config in package.json.
  this.require = arrify(config.require || opts.require)

  this._createDatastoreDirectories()

  this.transform = this._createTransform()

  this.sourceMapCache = new SourceMapCache()

  this.hashCache = {}
  this.loadedMaps = null
}

NYC.prototype._createTransform = function () {
  var _this = this
  return cachingTransform({
    salt: JSON.stringify({
      istanbul: require('istanbul/package.json').version,
      nyc: require('./package.json').version
    }),
    hash: function (code, metadata, salt) {
      var hash = md5hex([code, metadata.filename, salt])
      _this.hashCache['./' + metadata.relFile] = hash
      return hash
    },
    factory: this._transformFactory.bind(this),
    cacheDir: this.cacheDirectory(),
    disableCache: !this.enableCache,
    ext: '.js'
  })
}

NYC.prototype._loadAdditionalModules = function () {
  var _this = this
  this.require.forEach(function (r) {
    // first attempt to require the module relative to
    // the directory being instrumented.
    var p = resolveFrom(_this.cwd, r)
    if (p) {
      require(p)
      return
    }
    // now try other locations, .e.g, the nyc node_modules folder.
    require(r)
  })
}

NYC.prototype.instrumenter = function () {
  return this._instrumenter || (this._instrumenter = this._createInstrumenter())
}

NYC.prototype._createInstrumenter = function () {
  var configFile = path.resolve(this.cwd, './.istanbul.yml')

  if (!fs.existsSync(configFile)) configFile = undefined

  var istanbul = this.istanbul()

  var instrumenterConfig = istanbul.config.loadFile(configFile).instrumentation.config

  return new istanbul.Instrumenter({
    coverageVariable: '__coverage__',
    embedSource: instrumenterConfig['embed-source'],
    noCompact: !instrumenterConfig.compact,
    preserveComments: instrumenterConfig['preserve-comments']
  })
}

NYC.prototype._prepGlobPatterns = function (patterns) {
  if (!patterns) return patterns

  var result = []

  function add (pattern) {
    if (result.indexOf(pattern) === -1) {
      result.push(pattern)
    }
  }

  patterns.forEach(function (pattern) {
    // Allow gitignore style of directory exclusion
    if (!/\/\*\*$/.test(pattern)) {
      add(pattern.replace(/\/$/, '') + '/**')
    }

    add(pattern)
  })

  return result
}

NYC.prototype.addFile = function (filename) {
  var relFile = path.relative(this.cwd, filename)
  var source = stripBom(fs.readFileSync(filename, 'utf8'))
  var instrumentedSource = this._maybeInstrumentSource(source, filename, relFile)
  return {
    instrument: !!instrumentedSource,
    relFile: relFile,
    content: instrumentedSource || source
  }
}

NYC.prototype.shouldInstrumentFile = function (filename, relFile) {
  relFile = relFile.replace(/^\.\//, '') // remove leading './'.

  return (!this.include || micromatch.any(filename, this.include) || micromatch.any(relFile, this.include)) &&
    !(micromatch.any(filename, this.exclude) || micromatch.any(relFile, this.exclude))
}

NYC.prototype.addAllFiles = function () {
  var _this = this

  glob.sync('**/*.js', {nodir: true, ignore: this.exclude}).forEach(function (filename) {
    var obj = _this.addFile(filename, true)
    if (obj.instrument) {
      module._compile(
        _this.instrumenter().getPreamble(obj.content, obj.relFile),
        filename
      )
    }
  })

  this.writeCoverageFile()
}

NYC.prototype._maybeInstrumentSource = function (code, filename, relFile) {
  var instrument = this.shouldInstrumentFile(filename, relFile)

  if (!instrument) {
    return null
  }

  return this.transform(code, {filename: filename, relFile: relFile})
}

NYC.prototype._transformFactory = function (cacheDir) {
  var _this = this
  var instrumenter = this.instrumenter()

  return function (code, metadata, hash) {
    var filename = metadata.filename
    var relFile = './' + metadata.relFile

    var sourceMap = convertSourceMap.fromSource(code) || convertSourceMap.fromMapFileSource(code, path.dirname(filename))

    if (sourceMap) {
      if (hash) {
        var mapPath = path.join(cacheDir, hash + '.map')
        fs.writeFileSync(mapPath, sourceMap.toJSON())
      } else {
        _this.sourceMapCache.addMap(relFile, sourceMap.toJSON())
      }
    }

    return instrumenter.instrumentSync(code, relFile)
  }
}

NYC.prototype._wrapRequire = function () {
  var _this = this
  appendTransform(function (code, filename) {
    var relFile = path.relative(_this.cwd, filename)
    return _this._maybeInstrumentSource(code, filename, relFile) || code
  })
}

NYC.prototype.cleanup = function () {
  if (!process.env.NYC_CWD) rimraf.sync(this.tempDirectory())
}

NYC.prototype.clearCache = function () {
  rimraf.sync(this.cacheDirectory())
}

NYC.prototype._createDatastoreDirectories = function () {
  mkdirp.sync(this.tempDirectory())
}

NYC.prototype._wrapExit = function () {
  var _this = this

  // we always want to write coverage
  // regardless of how the process exits.
  onExit(function () {
    _this.writeCoverageFile()
  }, {alwaysLast: true})
}

NYC.prototype.wrap = function (bin) {
  this._wrapRequire()
  this._wrapExit()
  this._loadAdditionalModules()
  return this
}

NYC.prototype.writeCoverageFile = function () {
  var coverage = global.__coverage__
  if (typeof __coverage__ === 'object') coverage = __coverage__
  if (!coverage) return

  if (this.enableCache) {
    Object.keys(coverage).forEach(function (relFile) {
      if (this.hashCache[relFile] && coverage[relFile]) {
        coverage[relFile].contentHash = this.hashCache[relFile]
      }
    }, this)
  } else {
    this.sourceMapCache.applySourceMaps(coverage)
  }

  fs.writeFileSync(
    path.resolve(this.tempDirectory(), './', process.pid + '.json'),
    JSON.stringify(coverage),
    'utf-8'
  )
}

NYC.prototype.istanbul = function () {
  return this._istanbul || (this._istanbul = require('istanbul'))
}

NYC.prototype.report = function (cb, _collector, _reporter) {
  cb = cb || function () {}

  var istanbul = this.istanbul()
  var collector = _collector || new istanbul.Collector()
  var reporter = _reporter || new istanbul.Reporter()

  this._loadReports().forEach(function (report) {
    collector.add(report)
  })

  this.reporter.forEach(function (_reporter) {
    reporter.add(_reporter)
  })

  reporter.write(collector, true, cb)
}

NYC.prototype._loadReports = function () {
  var _this = this
  var files = fs.readdirSync(this.tempDirectory())

  var cacheDir = _this.cacheDirectory()

  var loadedMaps = this.loadedMaps || (this.loadedMaps = {})

  return files.map(function (f) {
    var report
    try {
      report = JSON.parse(fs.readFileSync(
        path.resolve(_this.tempDirectory(), './', f),
        'utf-8'
      ))
    } catch (e) { // handle corrupt JSON output.
      return {}
    }

    Object.keys(report).forEach(function (relFile) {
      var fileReport = report[relFile]
      if (fileReport && fileReport.contentHash) {
        var hash = fileReport.contentHash
        if (!(hash in loadedMaps)) {
          try {
            var mapPath = path.join(cacheDir, hash + '.map')
            loadedMaps[hash] = JSON.parse(fs.readFileSync(mapPath, 'utf8'))
          } catch (e) {
            // set to false to avoid repeatedly trying to load the map
            loadedMaps[hash] = false
          }
        }
        if (loadedMaps[hash]) {
          _this.sourceMapCache.addMap(relFile, loadedMaps[hash])
        }
      }
    })
    _this.sourceMapCache.applySourceMaps(report)
    return report
  })
}

NYC.prototype.tempDirectory = function () {
  return path.resolve(this.cwd, './', this._tempDirectory)
}

NYC.prototype.cacheDirectory = function () {
  return path.resolve(this.cwd, './', this._cacheDirectory)
}

NYC.prototype.mungeArgs = function (yargv) {
  var argv = process.argv.slice(1)
  argv = argv.slice(argv.indexOf(yargv._[0]))
  if (!/^(node|iojs)$/.test(argv[0]) &&
      process.platform === 'win32' &&
      (/\.js$/.test(argv[0]) ||
        (!/\.(cmd|exe)$/.test(argv[0]) &&
        !fs.existsSync(argv[0] + '.cmd') &&
        !fs.existsSync(argv[0] + '.exe')))) {
    argv.unshift(process.execPath)
  }

  return argv
}

module.exports = NYC
