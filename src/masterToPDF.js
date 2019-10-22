const pug = require('pug')
const colors = require('colors/safe')
const cheerio = require('cheerio')
const fs = require('fs')
const filesize = require('filesize')
const path = require('path')
const { performance } = require('perf_hooks')
/**
* buildOpts: {
  baseName: name,
  htmlFileName: htmlFileName
  pdfFileName: pdfFileName
  outputPath: relative path of output folder
}
 */
exports.masterToPDF = async function (masterPath, relaxedGlobals, buildOpts, locals) {
  var t0 = performance.now()
  var page = relaxedGlobals.puppeteerPage
  /*
   *            Generate HTML
   */
  var pluginHooks = relaxedGlobals.pluginHooks
  var html
  if (masterPath.endsWith('.pug')) {
    var pluginPugHeaders = []
    for (var pugHeader of pluginHooks.pugHeaders) {
      pluginPugHeaders.push(pugHeader.instance)
    }
    pluginPugHeaders = pluginPugHeaders.join('\n\n')

    var pugFilters = Object.assign(...pluginHooks.pugFilters.map(o => o.instance))
    try {
      var masterPug = fs.readFileSync(masterPath, 'utf8')
      global.data = Object.assign({}, locals ? locals : {});
      html = pug.render(pluginPugHeaders + '\n' + masterPug, Object.assign({
        filename: masterPath,
        fs: fs,
        basedir: relaxedGlobals.basedir,
        cheerio: cheerio,
        __root__: path.dirname(masterPath),
        path: path,
        require: require,
        performance: performance,
        filters: pugFilters
      },global.data))
    } catch (error) {
      console.log(error.message)
      console.error(colors.red('There was a Pug error (see above)'))
      throw error
      return
    }
  } else if (masterPath.endsWith('.html')) {
    html = fs.readFileSync(masterPath, 'utf8')
  }

  /*
   *            MODIFY HTML
   */
  var head = pluginHooks.headElements.map(e => e.instance).join(`\n\n`)
  html = `
    <html>
      <head>
        <meta charset="UTF-8">
        ${head}
      </head>
      <body> ${html} </body>
    </html>`

  for (var htmlModifier of pluginHooks.htmlModifiers) {
    html = await htmlModifier.instance(html)
  }

  let tempHTMLPath = path.join(buildOpts.outputPath,buildOpts.htmlFileName || `${buildOpts.baseName}_temp.htm`)
  fs.writeFileSync(tempHTMLPath, html)

  var tHTML = performance.now()
  console.log(colors.magenta(`... HTML generated in ${((tHTML - t0) / 1000).toFixed(1)}s`))

  /*
   *            LOAD HTML
   */
  var url = relaxedGlobals.baseUrl + "/" + tempHTMLPath
  console.log(`...url ${url}`)
  await page.goto(url, {
    waitUntil: ['load', 'domcontentloaded'],
    timeout: 300000,
  })
  var tLoad = performance.now()
  console.log(colors.magenta(`... Document loaded in ${((tLoad - tHTML) / 1000).toFixed(1)}s`))

  await waitForNetworkIdle(page, 200)
  var tNetwork = performance.now()
  console.log(colors.magenta(`... Network idled in ${((tNetwork - tLoad) / 1000).toFixed(1)}s`))

  // Get header/footer template
  var header = await page.$eval('#page-header', element => element.innerHTML)
    .catch(error => '')
  var footer = await page.$eval('#page-footer', element => element.innerHTML)
    .catch(error => '')

  if (header !== '' && footer === '') {
    footer = '<span></span>'
  }
  if ((footer !== '') && (header === '')) {
    header = '<span></span>'
  }
  /*
   *            Create PDF options
   */
  let pdfFilePath = path.join(buildOpts.outputPath,buildOpts.pdfFileName || `${buildOpts.baseName}.pdf` )
  var options = {
    path: pdfFilePath,
    displayHeaderFooter: !!(header || footer),
    headerTemplate: header,
    footerTemplate: footer,
    printBackground: true
  }

  options = Object.assign(options,relaxedGlobals.config.pdfOptions)

  function getMatch (string, query) {
    var result = string.match(query)
    if (result) {
      result = result[1]
    }
    return result
  }

  var width = getMatch(html, /-relaxed-page-width: (\S+);/m)
  if (width) {
    options.width = width
  }
  var height = getMatch(html, /-relaxed-page-height: (\S+);/m)
  if (height) {
    options.height = height
  }
  var size = getMatch(html, /-relaxed-page-size: (\S+);/m)
  if (size) {
    options.size = size
  }

  for (var pageModifier of pluginHooks.pageModifiers) {
    await pageModifier.instance(page)
  }

  for (pageModifier of pluginHooks.page2ndModifiers) {
    await pageModifier.instance(page)
  }

  // TODO: add option to output full html from page

  /*
   *            PRINT PAGE TO PDF
   */

  console.log("final pdf options")
  console.log(options)
  await page.pdf(options)

  var tPDF = performance.now()
  let duration = ((tPDF - tNetwork) / 1000).toFixed(1)
  let pdfSize = filesize(fs.statSync(pdfFilePath).size)
  console.log(colors.magenta(`... PDF written in ${duration}s (${pdfSize})`))
}

// Wait for all the content on the page to finish loading
function waitForNetworkIdle (page, timeout, maxInflightRequests = 0) {
  page.on('request', onRequestStarted)
  page.on('requestfinished', onRequestFinished)
  page.on('requestfailed', onRequestFinished)

  let inflight = 0
  let fulfill
  let promise = new Promise(x => fulfill = x)
  let timeoutId = setTimeout(onTimeoutDone, timeout)
  return promise

  function onTimeoutDone () {
    page.removeListener('request', onRequestStarted)
    page.removeListener('requestfinished', onRequestFinished)
    page.removeListener('requestfailed', onRequestFinished)
    fulfill()
  }

  function onRequestStarted () {
    ++inflight
    if (inflight > maxInflightRequests) {
      clearTimeout(timeoutId)
    }
  }

  function onRequestFinished () {
    if (inflight === 0) {
      return
    }
    --inflight
    if (inflight === maxInflightRequests) {
      timeoutId = setTimeout(onTimeoutDone, timeout)
    }
  }
}
