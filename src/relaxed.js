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
    baseUrl: opts.baseUrl || "file://",
  }

  async function init(){
      // LOAD BUILT-IN "ALWAYS-ON" PLUGINS
      for (var [i, plugin] of plugins.builtinDefaultPlugins.entries()) {
        plugins.builtinDefaultPlugins[i] = await plugin.constructor()
      }
      return puppeteer.launch(puppeteerConfig).then(browser =>{
        return browser.newPage();
      }).then(page =>{
        relaxedGlobals.puppeteerPage = page
        relaxedGlobals.puppeteerPage.on('pageerror', function (err) {
          console.log(colors.red('Page error: ' + err.toString()))
        }).on('error', function (err) {
          console.log(colors.red('Error: ' + err.toString()))
        })
        if(relaxedGlobals.config.view){
          var view = Object.assign({width: 800, height:600 },relaxedGlobals.config.view)
          return relaxedGlobals.puppeteerPage.setViewport(view)
        }else{
          return page;
        }
      }).then(page => {
        return plugins.updateRegisteredPlugins(relaxedGlobals, opts.inputDir);
      }).then(_ => {
        return this;
      });
  }

  function build(locals,buildOpts){
    if (relaxedGlobals.busy) {
      return Promise.reject(new Error('puppeteer too busy'))
    }
    relaxedGlobals.busy = true
    return masterToPDF(opts.inputPath, relaxedGlobals,buildOpts, locals)
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