/* eslint-disable no-eval, new-cap */
import path from 'path'
import fs from 'fs'
import {
  MatcherOptions,
  queries as baseQueries,
  waitForOptions as WaitForOptions,
} from '@testing-library/dom'
import 'simmerjs'
import {
  QueryArg,
  Config,
  QueryName,
  WebdriverIOQueries,
  WebdriverIOQueriesChainable,
  ObjectQueryArg,
  SerializedObject,
  SerializedArg,
} from './types'

declare global {
  interface Window {
    TestingLibraryDom: typeof baseQueries & {
      configure: typeof configure
    }
  }
}

const DOM_TESTING_LIBRARY_UMD_PATH = path.join(
  require.resolve('@testing-library/dom'),
  '../../',
  'dist/@testing-library/dom.umd.js',
)
const DOM_TESTING_LIBRARY_UMD = fs
  .readFileSync(DOM_TESTING_LIBRARY_UMD_PATH)
  .toString()
  .replace('define.amd', 'false') // Never inject DTL using AMD define function

const SIMMERJS = fs
  .readFileSync(require.resolve('simmerjs/dist/simmer.js'))
  .toString()

let _config: Partial<Config>

async function injectDOMTestingLibrary(element: WebdriverIO.Element) {
  const shouldInject = await element.execute(function executeShouldInject() {
    return {
      domTestingLibrary: !window.TestingLibraryDom,
      simmer: !window.Simmer,
    }
  })

  if (shouldInject.domTestingLibrary) {
    await element.execute(function executeInjectTestingLibrary(
      el: HTMLElement,
      library: string,
    ) {
      // add DOM Testing Library to page as a script tag to support Firefox
      if (navigator.userAgent.includes('Firefox')) {
        const script = document.createElement('script')
        script.innerHTML = library
        return document.head.append(script)
      }

      // eval library on other browsers
      return eval(library)
    }, DOM_TESTING_LIBRARY_UMD)
  }

  if (shouldInject.simmer) {
    await element.execute(SIMMERJS)
  }

  await element.execute(function executeConfigureTestingLibrary(
    el: HTMLElement,
    config: Partial<Config>,
  ) {
    window.TestingLibraryDom.configure(config)
  }, _config)
}

function serializeObject(object: ObjectQueryArg): SerializedObject {
  return Object.entries(object)
    .map<[string, SerializedArg]>(([key, value]: [string, QueryArg]) => [
      key,
      serializeArg(value),
    ])
    .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {
      serialized: 'object',
    })
}

function serializeArg(arg: QueryArg): SerializedArg {
  if (arg instanceof RegExp) {
    return { serialized: 'RegExp', RegExp: arg.toString() }
  }
  if (typeof arg === 'undefined') {
    return { serialized: 'Undefined', Undefined: true }
  }
  if (arg && typeof arg === 'object') {
    return serializeObject(arg)
  }
  return arg
}

type SerializedQueryResult =
  | { selector: string }[]
  | string
  | { selector: string }
  | null

async function executeQuery(
  container: HTMLElement,
  query: QueryName,
  ...args: SerializedArg[]
): Promise<SerializedQueryResult> {
  function deserializeObject(object: SerializedObject) {
    return Object.entries(object)
      .map<[string, QueryArg]>(([key, value]) => [key, deserializeArg(value)])
      .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {})
  }

  function deserializeArg(arg: SerializedArg): QueryArg {
    if (typeof arg === 'object' && arg.serialized === 'RegExp') {
      return eval(arg.RegExp)
    }
    if (typeof arg === 'object' && arg.serialized === 'Undefined') {
      return undefined
    }
    if (typeof arg === 'object') {
      return deserializeObject(arg)
    }
    return arg
  }

  const [matcher, options, waitForOptions] = args.map(deserializeArg)

  let result: ReturnType<(typeof window.TestingLibraryDom)[typeof query]> = null
  try {
    // Override RegExp to fix 'matcher instanceof RegExp' check on Firefox
    window.RegExp = RegExp

    result = await window.TestingLibraryDom[query](
      container,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      matcher as any,
      options as MatcherOptions,
      waitForOptions as WaitForOptions,
    )
  } catch (e: unknown) {
    return (e as Error).message
  }

  if (!result) {
    return null
  }

  function makeSelectorResult(element: HTMLElement) {
    // use simmer if possible to allow element refetching by position, otherwise
    // situations such as a React key change causes refetching to fail.
    const selector = window.Simmer(element)
    if (selector) return { selector }

    // use generated element id as selector if Simmer fails
    const elementIdAttributeName = 'data-wdio-testing-lib-element-id'
    let elementId = element.getAttribute(elementIdAttributeName)

    // if id doesn't already exist create one and add it to element
    if (!elementId) {
      elementId = (Math.abs(Math.random()) * 1000000000000).toFixed(0)
      element.setAttribute(elementIdAttributeName, elementId)
    }

    return { selector: `[${elementIdAttributeName}="${elementId}"]` }
  }

  if (Array.isArray(result)) {
    return result.map(makeSelectorResult)
  }

  return makeSelectorResult(result)
}

function createQuery(element: WebdriverIO.Element, queryName: QueryName) {
  return async (...args: QueryArg[]) => {
    await injectDOMTestingLibrary(element)

    const result: SerializedQueryResult = await element.execute(
      executeQuery,
      queryName,
      ...args.map(serializeArg),
    )

    if (typeof result === 'string') {
      throw new Error(result)
    }

    if (!result) {
      return null
    }

    if (Array.isArray(result)) {
      return Promise.all(result.map(({ selector }) => element.$(selector)))
    }

    return element.$(result.selector)
  }
}

function within(element: WebdriverIO.Element) {
  return (Object.keys(baseQueries) as QueryName[]).reduce(
    (queries, queryName) => ({
      ...queries,
      [queryName]: createQuery(element, queryName),
    }),
    {},
  ) as WebdriverIOQueries
}

function setupBrowser(browser: WebdriverIO.Browser): WebdriverIOQueries {
  const queries: {
    [key: string | number | symbol]: WebdriverIOQueries[QueryName]
  } = {}

  Object.keys(baseQueries).forEach((key) => {
    const queryName = key as QueryName

    const query = async (
      ...args: Parameters<WebdriverIOQueries[QueryName]>
    ) => {
      const body = await browser.$('body').getElement()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      return within(body)[queryName](...(args as any[]))
    }

    // add query to response queries
    queries[queryName] = query as WebdriverIOQueries[QueryName]

    // add query to BrowserObject and Elements
    browser.addCommand(queryName, query as WebdriverIOQueries[QueryName])
    browser.addCommand(
      queryName,
      function addQueryCommand(this, ...args) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        return within(this)[queryName](...args)
      },
      true,
    )

    // add chainable query to BrowserObject and Elements
    browser.addCommand(
      `${queryName}$`,
      query as unknown as WebdriverIOQueriesChainable<WebdriverIO.Browser>[`${QueryName}$`],
    )
    browser.addCommand(
      `${queryName}$`,
      function addQueryCommand(this, ...args) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        return within(this)[queryName](...args)
      },
      true,
    )
  })

  return queries as unknown as WebdriverIOQueries
}

function configure(config: Partial<Config>) {
  _config = config
}

export * from './types'
export { within, setupBrowser, configure }
