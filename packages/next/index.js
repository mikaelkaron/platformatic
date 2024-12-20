import {
  BaseStackable,
  transformConfig as basicTransformConfig,
  ChildManager,
  cleanBasePath,
  createChildProcessListener,
  createServerListener,
  errors,
  getServerUrl,
  importFile,
  resolvePackage,
  schemaOptions
} from '@platformatic/basic'
import { ConfigManager } from '@platformatic/config'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { dirname, resolve as pathResolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { satisfies } from 'semver'
import { packageJson, schema } from './lib/schema.js'

const supportedVersions = '^14.0.0'

export class NextStackable extends BaseStackable {
  #basePath
  #next
  #child
  #server

  constructor (options, root, configManager) {
    super('next', packageJson.version, options, root, configManager)
  }

  async init () {
    this.#next = pathResolve(dirname(resolvePackage(this.root, 'next')), '../..')
    const nextPackage = JSON.parse(await readFile(pathResolve(this.#next, 'package.json'), 'utf-8'))

    /* c8 ignore next 3 */
    if (!satisfies(nextPackage.version, supportedVersions)) {
      throw new errors.UnsupportedVersion('next', nextPackage.version, supportedVersions)
    }
  }

  async start ({ listen }) {
    // Make this idempotent
    if (this.url) {
      return this.url
    }

    if (this.isProduction) {
      await this.#startProduction(listen)
    } else {
      await this.#startDevelopment(listen)
    }
  }

  async stop () {
    if (this.subprocess) {
      return this.stopCommand()
    }

    if (this.isProduction) {
      return new Promise((resolve, reject) => {
        this.#server.close(error => {
          /* c8 ignore next 3 */
          if (error) {
            return reject(error)
          }

          resolve()
        })
      })
    } else {
      const exitPromise = once(this.#child, 'exit')
      await this.childManager.close()
      process.kill(this.#child.pid, 'SIGKILL')
      await exitPromise
    }
  }

  async build () {
    const config = this.configManager.current
    const loader = new URL('./lib/loader.js', import.meta.url)
    this.#basePath = config.application?.basePath ? cleanBasePath(config.application?.basePath) : ''

    let command = config.application.commands.build

    if (!command) {
      await this.init()
      command = ['node', pathResolve(this.#next, './dist/bin/next'), 'build', this.root]
    }

    return this.buildWithCommand(command, this.#basePath, loader)
  }

  /* c8 ignore next 5 */
  async getWatchConfig () {
    return {
      enabled: false
    }
  }

  getMeta () {
    const composer = { prefix: this.basePath ?? this.#basePath, wantsAbsoluteUrls: true, needsRootRedirect: false }

    if (this.url) {
      composer.tcp = true
      composer.url = this.url
    }

    return { composer }
  }

  async #startDevelopment () {
    const config = this.configManager.current
    const loaderUrl = new URL('./lib/loader.js', import.meta.url)
    const command = this.configManager.current.application.commands.development

    this.#basePath = config.application?.basePath ? cleanBasePath(config.application?.basePath) : ''

    if (command) {
      return this.startWithCommand(command, loaderUrl)
    }

    const { hostname, port } = this.serverConfig ?? {}
    const serverOptions = {
      host: hostname || '127.0.0.1',
      port: port || 0
    }

    this.childManager = new ChildManager({
      loader: loaderUrl,
      context: {
        serviceId: this.serviceId,
        workerId: this.workerId,
        // Always use URL to avoid serialization problem in Windows
        root: pathToFileURL(this.root).toString(),
        basePath: this.#basePath,
        logLevel: this.logger.level,
        port: false,
        isEntrypoint: this.isEntrypoint,
        runtimeBasePath: this.runtimeConfig.basePath,
        wantsAbsoluteUrls: true
      }
    })

    const promise = once(this.childManager, 'url')
    await this.#startDevelopmentNext(serverOptions)
    const [url, clientWs] = await promise
    this.url = url
    this.clientWs = clientWs
  }

  async #startDevelopmentNext (serverOptions) {
    const { nextDev } = await importFile(pathResolve(this.#next, './dist/cli/next-dev.js'))

    this.childManager.on('config', config => {
      this.#basePath = config.basePath
    })

    try {
      await this.childManager.inject()
      const childPromise = createChildProcessListener()
      await nextDev(serverOptions, 'default', this.root)
      this.#child = await childPromise
    } finally {
      await this.childManager.eject()
    }
  }

  async #startProduction (listen) {
    const config = this.configManager.current
    const loaderUrl = new URL('./lib/loader.js', import.meta.url)
    const command = this.configManager.current.application.commands.production

    this.#basePath = config.application?.basePath ? cleanBasePath(config.application?.basePath) : ''

    if (command) {
      return this.startWithCommand(command, loaderUrl)
    }

    this.childManager = new ChildManager({
      loader: loaderUrl,
      context: {
        serviceId: this.serviceId,
        workerId: this.workerId,
        // Always use URL to avoid serialization problem in Windows
        root: pathToFileURL(this.root).toString(),
        basePath: this.#basePath,
        logLevel: this.logger.level,
        isEntrypoint: this.isEntrypoint,
        runtimeBasePath: this.runtimeConfig.basePath,
        wantsAbsoluteUrls: true,
      }
    })

    this.verifyOutputDirectory(pathResolve(this.root, '.next'))
    await this.#startProductionNext()
  }

  async #startProductionNext () {
    try {
      await this.childManager.inject()
      const { nextStart } = await importFile(pathResolve(this.#next, './dist/cli/next-start.js'))

      const { hostname, port } = this.serverConfig ?? {}
      const serverOptions = {
        hostname: hostname || '127.0.0.1',
        port: port || 0
      }

      // Since we are in the same process
      process.once('plt:next:config', config => {
        this.#basePath = config.basePath
      })

      this.childManager.register()
      const serverPromise = createServerListener(
        (this.isEntrypoint ? serverOptions?.port : undefined) ?? true,
        (this.isEntrypoint ? serverOptions?.hostname : undefined) ?? true
      )

      await nextStart(serverOptions, this.root)

      this.#server = await serverPromise
      this.url = getServerUrl(this.#server)
    } finally {
      await this.childManager.eject()
    }
  }
}

/* c8 ignore next 9 */
function transformConfig () {
  if (this.current.watch === undefined) {
    this.current.watch = { enabled: false }
  }

  if (typeof this.current.watch !== 'object') {
    this.current.watch = { enabled: this.current.watch || false }
  }

  basicTransformConfig.call(this)
}

export async function buildStackable (opts) {
  const root = opts.context.directory

  const configManager = new ConfigManager({
    schema,
    source: opts.config ?? {},
    schemaOptions,
    transformConfig,
    dirname: root
  })
  await configManager.parseAndValidate()

  return new NextStackable(opts, root, configManager)
}

export default {
  configType: 'next',
  configManagerConfig: {
    schemaOptions,
    transformConfig
  },
  buildStackable,
  schema,
  version: packageJson.version
}
