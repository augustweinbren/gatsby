import fs from "fs-extra"
import glob from "glob"
import path from "path"
import webpack from "webpack"
import _ from "lodash"
import multer from "multer"
import * as express from "express"
import { urlResolve, getMatchPath } from "gatsby-core-utils"
import { ParentSpanPluginArgs, CreateDevServerArgs } from "gatsby"
import { internalActions } from "../../redux/actions"
import { reportWebpackWarnings } from "../../utils/webpack-error-utils"
import formatWebpackMessages from "react-dev-utils/formatWebpackMessages"
import dotenv from "dotenv"
import chokidar from "chokidar"
import pathToRegexp from "path-to-regexp"
import cookie from "cookie"

const isProductionEnv = process.env.gatsby_executing_command !== `develop`

interface IFunctionData {
  /** The route in the browser to access the function **/
  functionRoute: string
  /** The absolute path to the original function **/
  originalAbsoluteFilePath: string
  /** The relative path to the original function **/
  originalRelativeFilePath: string
  /** The relative path to the compiled function (always ends with .js) **/
  relativeCompiledFilePath: string
  /** The absolute path to the compiled function (doesn't transfer across machines) **/
  absoluteCompiledFilePath: string
  /** The matchPath regex created by path-to-regexp. Only created if the function is dynamic. **/
  matchPath: string
  /** The plugin that owns this function route **/
  pluginName: string
}

interface IGlobPattern {
  /** The plugin that owns this namespace **/
  pluginName: string
  /** The root path to the functions **/
  rootPath: string
  /** The glob pattern **/
  globPattern: string
}

// During development, we lazily compile functions only when they're requested.
// Here we keep track of which functions have been requested so are "active"
const activeDevelopmentFunctions = new Set<IFunctionData>()
let activeEntries = {}

async function ensureFunctionIsCompiled(
  functionObj: IFunctionData,
  compiledFunctionsDir: string
): any {
  // stat the compiled function. If it's there, then return.
  let compiledFileExists = false
  try {
    compiledFileExists = !!(await fs.stat(functionObj.absoluteCompiledFilePath))
  } catch (e) {
    // ignore
  }
  if (compiledFileExists) {
    return
  } else {
    // Otherwise, restart webpack by touching the file and watch for the file to be
    // compiled.
    const time = new Date()
    fs.utimesSync(functionObj.originalAbsoluteFilePath, time, time)
    console.log(`going to watch`, { compiledFunctionsDir })
    await new Promise(resolve => {
      const watcher = chokidar
        // Watch the root of the compiled function directory in .cache as chokidar
        // can't watch files in directories that don't yet exist.
        .watch(compiledFunctionsDir)
        .on(`add`, async _path => {
          console.log({
            _path,
            compiledFunctionPath: functionObj.absoluteCompiledFilePath,
          })
          if (_path === functionObj.absoluteCompiledFilePath) {
            await watcher.close()

            resolve(null)
          }
        })
    })
  }
}

// Create glob type w/ glob, plugin name, root path
const createGlobArray = (siteDirectoryPath, plugins): Array<IGlobPattern> => {
  const globs: Array<IGlobPattern> = []

  // Add the default site src/api directory.
  globs.push({
    globPattern: `${siteDirectoryPath}/src/api/**/*.{js,ts}`,
    rootPath: path.join(siteDirectoryPath, `src/api`),
    pluginName: `default-site-plugin`,
  })

  // Add the site src/pages directory.
  globs.push({
    globPattern: `${siteDirectoryPath}/src/pages/**/[\[]*[\]].{ts,js}`,
    rootPath: path.join(siteDirectoryPath, `src/pages`),
    pluginName: `default-site-plugin`,
    exportName: `getServerProps`,
    pathPrefix: `_pages`,
  })

  // Add each plugin
  plugins.forEach(plugin => {
    // Ignore the "default" site plugin (aka the src tree) as we're
    // already watching that.
    if (plugin.name === `default-site-plugin`) {
      return
    }
    // Ignore any plugins we include by default. In the very unlikely case
    // we want to ship default functions, we'll special case add them. In the
    // meantime, we'll avoid extra FS IO.
    if (plugin.resolve.includes(`internal-plugin`)) {
      return
    }
    if (plugin.resolve.includes(`gatsby-plugin-typescript`)) {
      return
    }
    if (plugin.resolve.includes(`gatsby-plugin-page-creator`)) {
      return
    }

    const glob = {
      globPattern: `${plugin.resolve}/src/api/${plugin.name}/**/*.{js,ts}`,
      rootPath: path.join(plugin.resolve, `src/api`),
      pluginName: plugin.name,
    } as IGlobPattern
    globs.push(glob)
  })

  // Only return unique paths
  return _.union(globs)
}

async function globAsync(pattern, options): Promise<Array<string>> {
  return await new Promise((resolve, reject) => {
    glob(pattern, options, (err, files) => {
      if (err) {
        reject(err)
      } else {
        resolve(files)
      }
    })
  })
}

const createWebpackConfig = async ({
  siteDirectoryPath,
  functionsDirectory,
  store,
  reporter,
}): Promise<webpack.Configuration> => {
  const compiledFunctionsDir = path.join(
    siteDirectoryPath,
    `.cache`,
    `functions`
  )

  const globs = createGlobArray(
    siteDirectoryPath,
    store.getState().flattenedPlugins
  )

  // Glob and return object with relative/absolute paths + which plugin
  // they belong to.
  const allFunctions = await Promise.all(
    globs.map(async glob => {
      const knownFunctions: Array<IFunctionData> = []
      const files = await globAsync(glob.globPattern)
      files.map(file => {
        const originalAbsoluteFilePath = file
        const originalRelativeFilePath = path.relative(glob.rootPath, file)

        const { dir, name } = path.parse(originalRelativeFilePath)
        const pathPrefix = glob.pathPrefix ? glob.pathPrefix : ``
        // Ignore the original extension as all compiled functions now end with js.
        const compiledFunctionName = path.join(pathPrefix, dir, name + `.js`)
        const compiledPath = path.join(
          compiledFunctionsDir,
          compiledFunctionName
        )
        const finalName = urlResolve(
          pathPrefix,
          dir,
          name === `index` ? `` : name
        )

        console.log({ pathPrefix, compiledFunctionName, finalName })

        knownFunctions.push({
          functionRoute: finalName,
          pluginName: glob.pluginName,
          originalAbsoluteFilePath,
          originalRelativeFilePath,
          relativeCompiledFilePath: compiledFunctionName,
          absoluteCompiledFilePath: compiledPath,
          exportName: glob.exportName ? glob.exportName : `default`,
          matchPath: getMatchPath(finalName),
        })
      })

      return knownFunctions
    })
  )

  // Combine functions by the route name so that functions in the default
  // functions directory can override the plugin's implementations.
  const knownFunctions = _.unionBy(
    ...allFunctions,
    func => func.functionRoute
  ) as Array<IFunctionData>

  store.dispatch(internalActions.setFunctions(knownFunctions))

  // Write out manifest for use by `gatsby serve` and plugins
  fs.writeFileSync(
    path.join(compiledFunctionsDir, `manifest.json`),
    JSON.stringify(knownFunctions, null, 4)
  )

  // Load environment variables from process.env.GATSBY_* and .env.* files.
  // Logic is shared with webpack.config.js

  // node env should be DEVELOPMENT | PRODUCTION as these are commonly used in node land
  const nodeEnv = process.env.NODE_ENV || `${defaultNodeEnv}`
  // config env is dependent on the env that it's run, this can be anything from staging-production
  // this allows you to set use different .env environments or conditions in gatsby files
  const configEnv = process.env.GATSBY_ACTIVE_ENV || nodeEnv
  const envFile = path.join(siteDirectoryPath, `./.env.${configEnv}`)
  let parsed = {}
  try {
    parsed = dotenv.parse(fs.readFileSync(envFile, { encoding: `utf8` }))
  } catch (err) {
    if (err.code !== `ENOENT`) {
      report.error(
        `There was a problem processing the .env file (${envFile})`,
        err
      )
    }
  }

  const envObject = Object.keys(parsed).reduce((acc, key) => {
    acc[key] = JSON.stringify(parsed[key])
    return acc
  }, {})

  const varsFromProcessEnv = Object.keys(process.env).reduce((acc, key) => {
    acc[key] = JSON.stringify(process.env[key])
    return acc
  }, {})

  // Don't allow overwriting of NODE_ENV, PUBLIC_DIR as to not break gatsby things
  envObject.NODE_ENV = JSON.stringify(nodeEnv)
  envObject.PUBLIC_DIR = JSON.stringify(`${siteDirectoryPath}/public`)

  const mergedEnvVars = Object.assign(envObject, varsFromProcessEnv)

  const processEnvVars = Object.keys(mergedEnvVars).reduce(
    (acc, key) => {
      acc[`process.env.${key}`] = mergedEnvVars[key]
      return acc
    },
    {
      "process.env": `({})`,
    }
  )

  const entries = {}
  const functionsList = isProductionEnv
    ? knownFunctions
    : activeDevelopmentFunctions
  functionsList.forEach(functionObj => {
    // Get path without the extension (as it could be ts or js)
    const parsedFile = path.parse(functionObj.relativeCompiledFilePath)
    const compiledNameWithoutExtension = path.join(
      parsedFile.dir,
      parsedFile.name
    )

    entries[compiledNameWithoutExtension] = functionObj.originalAbsoluteFilePath
  })

  activeEntries = entries

  const stage = isProductionEnv
    ? `functions-production`
    : `functions-development`

  const config = {
    entry: entries,
    output: {
      path: compiledFunctionsDir,
      filename: `[name].js`,
      libraryTarget: `commonjs2`,
    },
    target: `node`,

    // Minification is expensive and not as helpful for serverless functions.
    optimization: {
      minimize: false,
    },

    // Resolve files ending with .ts and the default extensions of .js, .json, .wasm
    resolve: {
      extensions: [`.ts`, `...`],
    },

    // Have webpack save its cache to the .cache/webpack directory
    cache: {
      type: `filesystem`,
      name: stage,
      cacheLocation: path.join(
        siteDirectoryPath,
        `.cache`,
        `webpack`,
        `stage-` + stage
      ),
    },

    mode: isProductionEnv ? `production` : `development`,
    // watch: !isProductionEnv,
    module: {
      rules: [
        {
          test: [/.js$/, /.ts$/],
          exclude: /node_modules/,
          use: {
            loader: `babel-loader`,
            options: {
              presets: [`@babel/typescript`],
            },
          },
        },
      ],
    },
    plugins: [new webpack.DefinePlugin(processEnvVars)],
  }

  return config
}

let isFirstBuild = true
export async function onPreBootstrap({
  reporter,
  store,
}: ParentSpanPluginArgs): Promise<void> {
  const activity = reporter.activityTimer(`Compiling Gatsby Functions`)
  activity.start()

  const {
    program: { directory: siteDirectoryPath },
  } = store.getState()

  const functionsDirectoryPath = path.join(siteDirectoryPath, `src/api`)

  const functionsDirectory = path.resolve(
    siteDirectoryPath,
    functionsDirectoryPath as string
  )

  reporter.verbose(`Attaching functions to development server`)
  const compiledFunctionsDir = path.join(
    siteDirectoryPath,
    `.cache`,
    `functions`
  )

  await fs.ensureDir(compiledFunctionsDir)
  await fs.emptyDir(compiledFunctionsDir)

  try {
    // We do this ungainly thing as we need to make accessible
    // the resolve/reject functions to our shared callback function
    // eslint-disable-next-line
    await new Promise(async (resolve, reject) => {
      const config = await createWebpackConfig({
        siteDirectoryPath,
        functionsDirectory,
        store,
        reporter,
      })

      function callback(err, stats): any {
        const rawMessages = stats.toJson({ moduleTrace: false })
        if (rawMessages.warnings.length > 0) {
          reportWebpackWarnings(rawMessages.warnings, reporter)
        }

        if (err) return reject(err)
        const errors = stats.compilation.errors || []

        // If there's errors, reject in production and print to the console
        // in development.
        if (isProductionEnv) {
          if (errors.length > 0) return reject(stats.compilation.errors)
        } else {
          const formated = formatWebpackMessages({
            errors: rawMessages.errors.map(e => e.message),
            warnings: [],
          })
          reporter.error(formated.errors)
        }

        // Log success in dev
        if (!isProductionEnv) {
          if (isFirstBuild) {
            isFirstBuild = false
          } else {
            reporter.success(`Re-building functions`)
          }
        }

        return resolve(null)
      }

      if (isProductionEnv) {
        webpack(config).run(callback)
      } else {
        // When in watch mode, you call things differently
        let compiler = webpack(config).watch({}, callback)

        const globs = createGlobArray(
          siteDirectoryPath,
          store.getState().flattenedPlugins
        )

        // Watch for env files to change and restart the webpack watcher.
        chokidar
          .watch(
            [
              `${siteDirectoryPath}/.env*`,
              ...globs.map(glob => glob.globPattern),
            ],
            { ignoreInitial: true }
          )
          .on(`all`, async (event, path) => {
            // Ignore change events from the API directory for functions we're
            // already watching.
            if (
              event === `change` &&
              Object.values(activeEntries).includes(path) &&
              path.includes(`/src/api/`)
            ) {
              return
            }

            reporter.log(
              `Restarting function watcher due to change to "${path}"`
            )

            // Otherwise, restart the watcher
            compiler.close(async () => {
              const config = await createWebpackConfig({
                siteDirectoryPath,
                functionsDirectory,
                store,
                reporter,
              })
              compiler = webpack(config).watch({}, callback)
            })
          })
      }
    })
  } catch (e) {
    activity.panic(`Failed to compile Gatsby Functions.`, e)
  }

  activity.end()
}

export async function onCreateDevServer({
  reporter,
  app,
  store,
}: CreateDevServerArgs): Promise<void> {
  reporter.verbose(`Attaching functions to development server`)

  const {
    program: { directory: siteDirectoryPath },
  } = store.getState()

  const compiledFunctionsDir = path.join(
    siteDirectoryPath,
    `.cache`,
    `functions`
  )

  app.use(
    `/api/*`,
    multer().any(),
    express.urlencoded({ extended: true }),
    (req, res, next) => {
      const cookies = req.headers.cookie

      if (!cookies) {
        return next()
      }

      req.cookies = cookie.parse(cookies)

      return next()
    },
    express.text(),
    express.json(),
    express.raw(),
    async (req, res, next) => {
      const { "0": pathFragment } = req.params

      const {
        functions,
      }: { functions: Array<IFunctionData> } = store.getState()

      // Check first for exact matches.
      let functionObj = functions.find(
        ({ functionRoute }) => functionRoute === pathFragment
      )

      if (!functionObj) {
        // Check if there's any matchPaths that match.
        // We loop until we find the first match.
        functions.some(f => {
          let exp
          const keys = []
          if (f.matchPath) {
            exp = pathToRegexp(f.matchPath, keys)
          }
          if (exp && exp.exec(pathFragment) !== null) {
            functionObj = f
            const matches = [...pathFragment.match(exp)].slice(1)
            const newParams = {}
            matches.forEach(
              (match, index) => (newParams[keys[index].name] = match)
            )
            req.params = newParams

            return true
          } else {
            return false
          }
        })
      }

      if (functionObj) {
        console.log({ functionObj })
        activeDevelopmentFunctions.add(functionObj)

        console.log(`before`)
        await ensureFunctionIsCompiled(functionObj, compiledFunctionsDir)
        console.log(`after`)

        reporter.verbose(`Running ${functionObj.functionRoute}`)
        const start = Date.now()
        const pathToFunction = functionObj.absoluteCompiledFilePath

        try {
          delete require.cache[require.resolve(pathToFunction)]
          const fn = require(pathToFunction)

          let fnToExecute
          let isSSRFunction = false
          console.log(`exportName`, functionObj.exportName, fn)
          if (functionObj.exportName === `default`) {
            fnToExecute = (fn && fn.default) || fn
          } else {
            isSSRFunction = true
            fnToExecute = fn && fn[functionObj.exportName]
          }

          const result = await Promise.resolve(fnToExecute(req, res))
          // SSR pages returns an object.
          if (isSSRFunction) {
            res.json(result)
          }
        } catch (e) {
          // Override the default error with something more specific.
          if (e.message.includes(`fnToExecute is not a function`)) {
            e.message = `${functionObj.originalAbsoluteFilePath} does not export a function.`
          }
          reporter.error(e)
          // Don't send the error if that would cause another error.
          if (!res.headersSent) {
            res
              .status(500)
              .send(
                `Error when executing function "${functionObj.originalAbsoluteFilePath}":<br /><br />${e.message}`
              )
          }
        }

        const end = Date.now()
        reporter.log(
          `Executed function "/api/${functionObj.functionRoute}" in ${
            end - start
          }ms`
        )
      } else {
        next()
      }
    }
  )
}