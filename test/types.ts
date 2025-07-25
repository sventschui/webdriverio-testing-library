/*
eslint-disable
@typescript-eslint/no-namespace,
@typescript-eslint/no-empty-interface
*/

import { WebdriverIOQueriesChainable, WebdriverIOQueries } from '../src'

declare global {
  namespace WebdriverIO {
    interface Browser
      extends WebdriverIOQueries,
        WebdriverIOQueriesChainable<Browser> {}
    interface Element
      extends WebdriverIOQueries,
        WebdriverIOQueriesChainable<Element> {}
  }
}
