#!/usr/bin/env node

const colors = require('colors/safe')
const chokidar = require('chokidar')
const puppeteer = require('puppeteer')
const yaml = require('js-yaml')
const { performance } = require('perf_hooks')
const path = require('path')
const fs = require('fs')
const ReLaXed = require('./relaxed.js')
global.program = require('commander')

var input, output
const version = require('../package.json').version

program
  .version(version)
  .usage('<input> [output] [options]')
  .arguments('<input> [output] [options]')
  .option('--no-sandbox', 'disable puppeteer sandboxing')
  .option('-w, --watch <locations>', 'Watch other locations', [])
  .option('-t, --temp [location]', 'Directory for temp file')
  .option('--bo, --build-once', 'Build once only, do not watch')
  .option('-l, --locals <json>', 'Json locals for pug rendering')
  .option('-v, --values <value>', "value file")
  .option('--basedir <location>', 'Base directory for absolute paths, e.g. /')

  .action(function (inp, out) {
    input = inp
    output = out
  })

// ARGUMENTS PARSING AND SETUP

program.parse(process.argv)

if (!input || fs.lstatSync(input).isDirectory()) {
  input = autodetectMasterFile(input)
}

const inputPath = path.resolve(input)
const inputDir = path.resolve(inputPath, '..')
const inputFilenameNoExt = path.basename(input, path.extname(input))
const outputBaseName = path.basename(output,path.extname(output))

var configPath
for (var filename of ['config.yml', 'config.json']) {
  let possiblePath = path.join(inputDir, filename)
  if (fs.existsSync(possiblePath)) {
    configPath = possiblePath
  }
}


// Output file, path, and temp html path
if (!output) {
  output = path.join(inputDir, inputFilenameNoExt + '.pdf')
}

var tempDir
if (program.temp) {
  var validTempPath = fs.existsSync(program.temp) && fs.statSync(program.temp).isDirectory()

  if (validTempPath) {
    tempDir = path.resolve(program.temp)
  } else {
    console.error(colors.red('ReLaXed error: Could not find specified --temp directory: ' +
      program.temp))
    process.exit(1)
  }
} else {
  tempDir = inputDir
}
const outputPath = path.relative(process.cwd(),tempDir)


const tempHTMLPath = path.join(tempDir, outputBaseName + '_temp.htm')

// Default and additional watch locations
let watchLocations = [inputDir]
if (program.watch) {
  watchLocations = watchLocations.concat(program.watch)
}

var locals = {}
if (program.locals) {
  try {
    locals = JSON.parse(program.locals)
  } catch (e) {
    console.error(e)
    colors.red('ReLaXed error: Could not parse locals JSON, see above.')
  }
}

if (program.values) {
  try {
    console.log(colors.magenta(`... Loading Value file ${program.values}`))
    var data = fs.readFileSync(program.values, 'utf8')
    Object.assign(locals, yaml.safeLoad(data))
  } catch (e) {
    console.error(e)
    colors.red(`Fail to read value file ${program.values}`)
  }
}



/*
 * ==============================================================
 *                         MAIN
 * ==============================================================
 */



function loadConfig() {
  let config = {}
  if (configPath) {
    console.log(colors.magenta('... Reading config file ' + configPath))
    var data = fs.readFileSync(configPath, 'utf8')
    if (configPath.endsWith('.json')) {
      config = JSON.parse(data)
    } else {
      config = yaml.safeLoad(data)
    }
  }
  return config
}



async function main() {
  console.log(colors.magenta.bold('Launching ReLaXed...'))

  // LOAD BUILT-IN "ALWAYS-ON" PLUGINS
  // await updateConfig()
  let config = loadConfig();

  let relaxed = ReLaXed.instance(Object.assign({
    inputPath: inputPath,
    inputDir: inputDir,
    tempDir: tempDir,
    config: config,
    baseUrl: `http://localhost:8080`
  },program))

  await relaxed.init()

  await relaxed.build(locals,{
    outputPath: outputPath,
    baseName: outputBaseName
  }).catch((error)=> {
    console.log(colors.red(error))
  })

  if (program.buildOnce) {
    process.exit(0)
  } else {
    watch(relaxed)
  }
}

/*
 * ==============================================================
 *                         BUILD
 * ==============================================================
 */

async function build(filepath) {
  var shortFileName = filepath.replace(inputDir, '')
  if ((path.basename(filepath) === 'config.yml') || (filepath.endsWith('.plugin.js'))) {
    await updateConfig()
    return
  }
  var page = relaxedGlobals.puppeteerPage
  // Ignore the call if ReLaXed is already busy processing other files.

  if (!(relaxedGlobals.watchedExtensions.some(ext => filepath.endsWith(ext)))) {
    if (!(['.pdf', '.htm'].some(ext => filepath.endsWith(ext)))) {
      console.log(colors.grey(`No process defined for file ${shortFileName}.`))
    }
    return
  }

  if (relaxedGlobals.busy) {
    console.log(colors.grey(`File ${shortFileName}: ignoring trigger, too busy.`))
    return
  }

  console.log(colors.magenta.bold(`\nProcessing ${shortFileName}...`))
  relaxedGlobals.busy = true
  var t0 = performance.now()


  var taskPromise = null

  for (var watcher of relaxedGlobals.pluginHooks.watchers) {
    if (watcher.instance.extensions.some(ext => filepath.endsWith(ext))) {
      taskPromise = watcher.instance.handler(filepath, page)
      break
    }
  }

  if (!taskPromise) {
    taskPromise = masterToPDF(inputPath, relaxedGlobals, tempHTMLPath, outputPath, locals)
  }
  await taskPromise
  var duration = ((performance.now() - t0) / 1000).toFixed(2)
  console.log(colors.magenta.bold(`... Done in ${duration}s`))
  relaxedGlobals.busy = false
}

/**
 * Watch `watchLocations` paths for changes and continuously rebuild
 *
 * @param {puppeteer.Page} page
 */

/*
 * ==============================================================
 *                         WATCH
 * ==============================================================
 */

function watch(relaxed) {
  console.log(colors.magenta(`\nNow idle and waiting for file changes.`))
  chokidar.watch(watchLocations, {
    awaitWriteFinish: {
      stabilityThreshold: 50,
      pollInterval: 100
    }
  }).on('change',(filepath) => {
    if(path.resolve(filepath).startsWith(path.resolve(tempDir))){
      console.log(colors.grey(`ignore file ${filepath} from temp dir`))
      return
    }
    var p = relaxed.fileChanged(filepath)
    if(!p){
      console.log(colors.magenta('... Rebuilding'))
      relaxed.build(locals,{
        outputPath: outputPath,
        baseName: outputBaseName
      })
    }
  })
}

function autodetectMasterFile(input) {
  var dir = input || '.'
  var files = fs.readdirSync(dir).filter((name) => name.endsWith('.pug'))
  var filename
  if (files.length === 1) {
    filename = files[0]
  } else if (files.indexOf('master.pug') >= 0) {
    filename = 'master.pug'
  } else {
    var error
    if (input) {
      error = `Could not find a master file in the provided directory ${input}`
    } else {
      error = `No input provided and could not find a master file in the current directory`
    }
    console.log(colors.red.bold(error))
    program.help()
    process.exit(1)
  }
  return path.join(dir, filename)
}

main()
