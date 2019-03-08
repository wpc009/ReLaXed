const plugins = require('./plugins')
const { masterToPDF } = require('./masterToPDF.js')
const puppeteer = require('puppeteer')
const colors = require('colors/safe')
const path = require('path')

exports.instance = function(opts){
  const puppeteerConfig = {
    headless: true,
    args: (opts.sandbox ? []:['--no-sandbox','--disable-setuid-sandbox']).concat([
      '--disable-gpu',
      '--hide-scrollbars',
      '--disable-translate',
      '--disable-web-security',
      '--disable-extensions',
      '--disable-sync'
    ])
  }


  const relaxedGlobals = {
    busy: false,
    config: opts.config,
    configPlugins: [],
    basedir: opts.basedir || opts.inputDir,
    tempDir: opts.tempDir,
  }

  async function init(){
      // LOAD BUILT-IN "ALWAYS-ON" PLUGINS
      for (var [i, plugin] of plugins.builtinDefaultPlugins.entries()) {
        plugins.builtinDefaultPlugins[i] = await plugin.constructor()
      }
      const browser = await puppeteer.launch(puppeteerConfig)
      relaxedGlobals.puppeteerPage = await browser.newPage()
    
      relaxedGlobals.puppeteerPage.on('pageerror', function (err) {
        console.log(colors.red('Page error: ' + err.toString()))
      }).on('error', function (err) {
        console.log(colors.red('Error: ' + err.toString()))
      })
    
      if(relaxedGlobals.config.view){
        
        var view = Object.assign({width: 800, height:600 },relaxedGlobals.config.view)
        await relaxedGlobals.puppeteerPage.setViewport(view)
      }


      await plugins.updateRegisteredPlugins(relaxedGlobals, opts.inputDir)
      return this
  }

  function build(locals,outputPath){
    if (relaxedGlobals.busy) {
      return Promise.reject(new Error('puppeteer too busy'))
    }
    relaxedGlobals.busy = true
    let tempHTMLPath = path.join(opts.tempDir, path.basename(outputPath, path.extname(outputPath)) + '_temp.htm')
    return masterToPDF(opts.inputPath, relaxedGlobals,tempHTMLPath, outputPath, locals)
    .then(()=> {
      relaxedGlobals.busy = false
      console.log(colors.magenta(`... Generating PDF finished, busy: ${relaxedGlobals.busy}`))
    })
  }

  function fileChanged(filepath){
      var shortFileName = filepath.replace(opts.inputDir, '')
      if ((path.basename(filepath) === 'config.yml') || (filepath.endsWith('.plugin.js'))) {
        // await updateConfig()
        return
      }
      var page = relaxedGlobals.puppeteerPage
      // Ignore the call if ReLaXed is already busy processing other files.
    
      if (!(relaxedGlobals.watchedExtensions.some(ext => filepath.endsWith(ext)))) {
        if (!(['.pdf', '.htm'].some(ext => filepath.endsWith(ext)))) {
          console.log(colors.grey(`No process defined for file ${shortFileName}.`))
        }
        return Promise.resolve("")
      }
    
      if (relaxedGlobals.busy) {
        return Promise.reject(new Error(`File ${shortFileName}: ignoring trigger, too busy.`))
      }
    
      console.log(colors.magenta.bold(`\nProcessing ${shortFileName}...`))
      var taskPromise = null
    
      for (var watcher of relaxedGlobals.pluginHooks.watchers) {
        if (watcher.instance.extensions.some(ext => filepath.endsWith(ext))) {
          relaxedGlobals.busy = true
          taskPromise = watcher.instance.handler(filepath, page).then(()=>{
            relaxedGlobals.busy = false
          })
          break
        }
      }

      return taskPromise
  }

  return {
    init: init,
    build: build,
    fileChanged: fileChanged
  }
  
}